'use strict';

// Reads Claude Code's session transcripts under ~/.claude/projects/.
//
// The transcript format is internal to Claude Code and changes between
// releases (documented at https://code.claude.com/docs/en/sessions), so
// every function here fails soft: skip the file / line, mark the field
// "unknown". Never throw on a malformed or missing transcript.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
const USAGE_NOISE_THRESHOLD = 50;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsDir() {
  return path.join(claudeDir(), 'projects');
}

function readCleanupPeriodDays() {
  const settingsPath = path.join(claudeDir(), 'settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    const value = settings.cleanupPeriodDays;
    if (typeof value === 'number' && value > 0) return value;
  } catch {
    // missing/unreadable/invalid settings.json — fall through to default
  }
  return 30;
}

// Reads the real, un-mangled cwd from the first parseable JSONL line.
// The encoded project-path directory name (non-alphanumeric -> '-') is
// lossy and must not be used as a substitute.
function resolveSessionCwd(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry.cwd === 'string' && entry.cwd.length > 0) {
        return entry.cwd;
      }
    } catch {
      continue;
    }
  }
  return null;
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

// message.usage.input_tokens is frequently a streaming placeholder (often
// exactly 1), not a final value — confirmed via
// https://github.com/anthropics/claude-code/issues/28197. Scanning from the
// end and taking the first total that clears a noise threshold finds the
// real value in practice. Summing everything double-counts across
// streaming updates; taking the literal last line often lands on a
// placeholder. Neither of those is a fix.
function estimateContextUsage(filePath, contextWindowTokens) {
  const windowSize = contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { tokens: null, ratio: null, unknown: true };
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const usage = entry && entry.message && entry.message.usage;
    const total = usageTotal(usage);
    if (total !== null && total >= USAGE_NOISE_THRESHOLD) {
      return { tokens: total, ratio: total / windowSize, unknown: false };
    }
  }
  return { tokens: null, ratio: null, unknown: true };
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

// Enumerates every live (not-yet-cleaned-up) session across all encoded
// project directories. contextWindowTokens comes from config.json — this
// tool doesn't auto-detect the model's real context window.
function listLiveSessions(contextWindowTokens) {
  const root = projectsDir();
  let projectDirs;
  try {
    projectDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
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
      const cwd = resolveSessionCwd(filePath);
      const usage = estimateContextUsage(filePath, contextWindowTokens);
      sessions.push({
        sessionId: path.basename(filePath, '.jsonl'),
        filePath,
        encodedProjectDir: path.basename(projectDir),
        cwd,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        contextTokens: usage.tokens,
        contextRatio: usage.ratio,
        contextUnknown: usage.unknown,
      });
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

function findSessionFile(sessionId) {
  const root = projectsDir();
  let projectDirs;
  try {
    projectDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return null;
  }
  for (const projectDir of projectDirs) {
    const candidate = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Async line-by-line read for large files (avoids loading multi-MB
// transcripts fully into memory just to find the cwd or tail usage).
async function resolveSessionCwdStreaming(filePath) {
  let stream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch {
    return null;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (typeof entry.cwd === 'string' && entry.cwd.length > 0) {
          rl.close();
          stream.destroy();
          return entry.cwd;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = {
  claudeDir,
  projectsDir,
  readCleanupPeriodDays,
  resolveSessionCwd,
  resolveSessionCwdStreaming,
  estimateContextUsage,
  listLiveSessions,
  findSessionFile,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  USAGE_NOISE_THRESHOLD,
};
