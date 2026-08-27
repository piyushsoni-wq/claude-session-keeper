'use strict';

// Builds a "resume-brief" for a session by shelling out to the local
// `claude` CLI in headless mode (`-p`/--print`). Deliberately NOT the raw
// Anthropic API: enterprise-plan users often have no ANTHROPIC_API_KEY at
// all (auth is OAuth/keychain, the same as any interactive `claude`
// session) — the CLI already knows how to authenticate without one.
// Confirmed empirically (not assumed): `claude -p ... --output-format
// json` returns `is_error`/`result` and succeeds with no
// ANTHROPIC_API_KEY set, `--no-session-persistence` leaves no transcript
// file behind (so summarizing doesn't itself create sessions for this
// tool to manage), and a ~150k-character positional prompt argument works
// fine via execFile (no ARG_MAX issue, no shell-quoting concerns since
// execFile never goes through a shell).

const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_EFFORT = 'low'; // summarization is a rote task, not deep reasoning
const TRUNCATE_CHARS = 150000;
const CLI_TIMEOUT_MS = 5 * 60 * 1000;

const SYSTEM_PROMPT = `You write concise "resume briefs" for Claude Code sessions. Given a
transcript, produce markdown a fresh session can read to pick up exactly
where this one left off. Include, only where the transcript actually
supports it:

- Goal: what the user was trying to accomplish
- Key decisions made and why (skip anything reversed or abandoned)
- Current state: what's done vs. still open
- Important file paths, identifiers, commands mentioned
- Next steps / open questions or blockers

Keep it under ~400 words. Do not invent details not present in the
transcript. If the transcript is truncated (marked below), say so and
note that earlier context may be missing. Reply with the markdown brief
only — no preamble, no "here is your summary".`;

// Best-effort text extraction. The transcript format is internal to
// Claude Code and can change between releases — skip anything that
// doesn't parse rather than throwing.
function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[tool call: ${block.name}]`);
    }
    // tool_result / thinking blocks intentionally omitted — noisy and
    // often large; the text blocks carry the substance for a resume-brief.
  }
  return parts.join('\n');
}

function extractTranscript(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { text: '', truncated: false, cwd: null };
  }

  const lines = raw.split('\n');
  const turns = [];
  let cwd = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;

    const role = entry.type === 'user' || entry.type === 'assistant' ? entry.type : null;
    if (!role || !entry.message) continue;
    const text = extractContentText(entry.message.content).trim();
    if (text) turns.push(`### ${role}\n${text}`);
  }

  const full = turns.join('\n\n');
  if (full.length <= TRUNCATE_CHARS) {
    return { text: full, truncated: false, cwd };
  }
  return { text: full.slice(-TRUNCATE_CHARS), truncated: true, cwd };
}

// Models sometimes wrap an entire markdown response in a single fenced
// code block despite being asked not to (observed in real testing, not
// hypothetical) — strip it so a saved summary starts with its actual
// heading, not a stray ```markdown line.
function stripWrappingCodeFence(text) {
  const match = /^```[a-zA-Z]*\n([\s\S]*)\n```\s*$/.exec(text.trim());
  return match ? match[1] : text;
}

// Runs `claude -p` headless, with all built-in tools disabled (`--tools
// ""`) since this is a pure text-in/text-out call — no file/bash access
// needed, and disabling it avoids any permission prompt entirely.
function callClaudeCli({ model, systemPrompt, userPrompt }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', userPrompt,
      '--system-prompt', systemPrompt,
      '--model', model || DEFAULT_MODEL,
      '--effort', DEFAULT_EFFORT,
      '--output-format', 'json',
      '--no-session-persistence',
      '--tools', '',
    ];
    execFile(
      'claude',
      args,
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          const detail = err ? err.message : String(stderr || '').slice(0, 300);
          reject(new Error(`claude CLI did not return valid JSON — ${detail}`));
          return;
        }
        if (parsed.is_error) {
          reject(new Error(parsed.result || 'claude CLI reported an error'));
          return;
        }
        resolve(parsed.result || '');
      },
    );
  });
}

async function summarizeSession(filePath, { model } = {}) {
  const { text, truncated, cwd } = extractTranscript(filePath);
  if (!text) {
    return {
      markdown: '_No extractable conversation text found in this session._',
      truncated: false,
      cwd,
    };
  }

  const userPrompt = truncated
    ? `[Transcript truncated to the most recent ${TRUNCATE_CHARS.toLocaleString()} characters — earlier context is missing]\n\n${text}`
    : text;

  const rawMarkdown = await callClaudeCli({
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
  });

  return { markdown: stripWrappingCodeFence(rawMarkdown), truncated, cwd };
}

module.exports = {
  extractTranscript,
  summarizeSession,
  stripWrappingCodeFence,
  DEFAULT_MODEL,
  TRUNCATE_CHARS,
};
