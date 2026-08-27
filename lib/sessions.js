'use strict';

// Reads Claude Code's session transcripts under ~/.claude/projects/ (or
// any other root that holds the same layout — the mirror backup, e.g.).
//
// The transcript format is internal to Claude Code and changes between
// releases (documented at https://code.claude.com/docs/en/sessions), so
// every function here fails soft: skip the file / line, mark the field
// "unknown". Never throw on a malformed or missing transcript.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Current Claude models (Sonnet 5, Opus 5, etc.) default to a 1M token
// context window. Used only when config.json doesn't set
// contextWindowTokens — lower it if you're pinned to a smaller-window
// model.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1000000;
const USAGE_NOISE_THRESHOLD = 50;
const TITLE_FALLBACK_MAX_CHARS = 60;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsDir() {
  return path.join(claudeDir(), 'projects');
}

function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ];
  let total = 0;
  let sawAny = false;
  for (const part of parts) {
    if (typeof part === 'number' && Number.isFinite(part)) {
      total += part;
      sawAny = true;
    }
  }
  return sawAny ? total : null;
}

function extractFirstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

function truncate(text, maxChars) {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

// Confirmed against real data: alongside (and in addition to) inline
// `custom-title` entries in the transcript itself, Claude Code also
// keeps a small side-car file at <session-id>/custom-title.json — e.g.
// {"customTitle":"TWP-5695"}. Where both exist they matched in every
// real session checked; the side-car is treated as authoritative since
// it's the cheap dedicated file a UI would read, with the inline
// transcript entry as the fallback for sessions that predate/lack it.
function readCustomTitleSidecar(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');
  const sidecarPath = path.join(path.dirname(filePath), sessionId, 'custom-title.json');
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.customTitle === 'string' && parsed.customTitle.trim()) {
      return parsed.customTitle.trim();
    }
  } catch {
    // no side-car file, or unreadable/malformed — fall through
  }
  return null;
}

// Single read + single line-scan per file, extracting everything the
// dashboard needs about a session in one pass: real cwd (from the top-
// level "cwd" field every line carries), a human-readable title, and an
// estimated context-window usage. Reading a 26MB real-world transcript
// three separate times (once each for cwd/usage/title) was the previous
// design — this replaces all three with one.
//
// Title priority: a user-set `custom-title` entry beats an
// auto-generated `ai-title` entry (both confirmed to exist in real
// Claude Code transcripts), which beats a truncated first user message,
// which beats nothing (caller falls back to the session id).
//
// Usage: message.usage.input_tokens is frequently a streaming
// placeholder (often exactly 1), not a final value — confirmed via
// https://github.com/anthropics/claude-code/issues/28197. The old
// implementation scanned from the end and returned the first total that
// cleared a noise threshold; a single forward pass that keeps
// *overwriting* "last qualifying total" whenever a line clears the
// threshold ends up holding that exact same value (the qualifying line
// closest to the end of the file) — provably equivalent, no backward
// scan needed.
function analyzeSessionFile(filePath, { contextWindowTokens } = {}) {
  const windowSize = contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { cwd: null, title: null, contextTokens: null, contextRatio: null, contextUnknown: true };
  }

  let cwd = null;
  let customTitle = null;
  let aiTitle = null;
  let firstUserText = null;
  let lastQualifyingUsage = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!cwd && typeof entry.cwd === 'string' && entry.cwd.length > 0) {
      cwd = entry.cwd;
    }

    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
      customTitle = entry.customTitle.trim();
    } else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
      aiTitle = entry.aiTitle.trim();
    }

    if (firstUserText === null && entry.type === 'user' && entry.message) {
      const text = extractFirstText(entry.message.content);
      if (text && text.trim()) firstUserText = text;
    }

    const usage = entry && entry.message && entry.message.usage;
    const total = usageTotal(usage);
    if (total !== null && total >= USAGE_NOISE_THRESHOLD) {
      lastQualifyingUsage = total;
    }
  }

  const title = readCustomTitleSidecar(filePath)
    || customTitle
    || aiTitle
    || (firstUserText ? truncate(firstUserText, TITLE_FALLBACK_MAX_CHARS) : null);

  return {
    cwd,
    title,
    contextTokens: lastQualifyingUsage,
    contextRatio: lastQualifyingUsage !== null ? lastQualifyingUsage / windowSize : null,
    contextUnknown: lastQualifyingUsage === null,
  };
}

// Thin wrappers kept for call sites / tests that only need one field —
// each still does exactly one read via analyzeSessionFile.
function resolveSessionCwd(filePath) {
  return analyzeSessionFile(filePath).cwd;
}

function resolveSessionTitle(filePath) {
  return analyzeSessionFile(filePath).title;
}

function estimateContextUsage(filePath, contextWindowTokens) {
  const a = analyzeSessionFile(filePath, { contextWindowTokens });
  return { tokens: a.contextTokens, ratio: a.contextRatio, unknown: a.contextUnknown };
}

function listSessionFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name));
}

// Enumerates every session under `rootDir` (which must have the same
// layout as ~/.claude/projects: one subdirectory per encoded project
// path, session files directly inside). Used for both the live
// directory and the mirror backup — same shape either way.
function listSessionsInDir(rootDir, { contextWindowTokens } = {}) {
  let projectDirs;
  try {
    projectDirs = fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(rootDir, e.name));
  } catch {
    return [];
  }

  const sessions = [];
  for (const projectDir of projectDirs) {
    for (const filePath of listSessionFiles(projectDir)) {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const analysis = analyzeSessionFile(filePath, { contextWindowTokens });
      sessions.push({
        sessionId: path.basename(filePath, '.jsonl'),
        filePath,
        encodedProjectDir: path.basename(projectDir),
        cwd: analysis.cwd,
        title: analysis.title,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        contextTokens: analysis.contextTokens,
        contextRatio: analysis.contextRatio,
        contextUnknown: analysis.contextUnknown,
      });
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

function listLiveSessions(contextWindowTokens) {
  return listSessionsInDir(projectsDir(), { contextWindowTokens });
}

// Real session IDs are UUIDs; this is intentionally a little more
// permissive than that, but still refuses anything that could turn
// `${sessionId}.jsonl` into a path-traversal payload (a `sessionId`
// reaches here straight from an HTTP request body — see
// dashboard/server.js) before it's ever joined into a filesystem path.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && SAFE_SESSION_ID_RE.test(sessionId);
}

function findSessionFileIn(rootDir, sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  let projectDirs;
  try {
    projectDirs = fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(rootDir, e.name));
  } catch {
    return null;
  }
  for (const projectDir of projectDirs) {
    const candidate = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findSessionFile(sessionId) {
  return findSessionFileIn(projectsDir(), sessionId);
}

// Deletes a session's .jsonl plus its matching <session-id>/
// subdirectory (subagents/tool-results), if present. Shared by live and
// mirror session deletion — both are "remove this session from this
// directory tree," just a different root.
function deleteSessionIn(rootDir, sessionId) {
  const filePath = findSessionFileIn(rootDir, sessionId);
  if (!filePath) {
    throw new Error(`Session ${sessionId} not found`);
  }
  fs.unlinkSync(filePath);
  const sessionDir = path.join(path.dirname(filePath), sessionId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  return filePath;
}

module.exports = {
  claudeDir,
  projectsDir,
  analyzeSessionFile,
  resolveSessionCwd,
  resolveSessionTitle,
  estimateContextUsage,
  listSessionsInDir,
  listLiveSessions,
  findSessionFileIn,
  findSessionFile,
  deleteSessionIn,
  isSafeSessionId,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  USAGE_NOISE_THRESHOLD,
};
