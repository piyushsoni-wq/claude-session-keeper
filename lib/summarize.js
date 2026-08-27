'use strict';

// Builds a "resume-brief" for a session by sending its transcript to the
// Claude API (Messages endpoint, raw fetch — this repo has zero npm deps
// by design, see dashboard/server.js). Needs the user's own
// ANTHROPIC_API_KEY in the environment; never read from config.json or
// written to disk.

const fs = require('fs');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 4096;
const TRUNCATE_CHARS = 150000;
const MAX_RETRIES = 3;

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
note that earlier context may be missing.`;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fire-and-forget-friendly: retries 429/5xx with backoff, fails fast on
// 4xx (bad key, bad request) since retrying those never helps.
async function callAnthropic({ apiKey, model, systemPrompt, userPrompt, maxTokens }) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
    } catch (networkErr) {
      lastError = networkErr;
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      const textBlock = (data.content || []).find((b) => b.type === 'text');
      return textBlock ? textBlock.text : '';
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt;
      lastError = new Error(`Anthropic API ${response.status}, retrying`);
      await sleep(delayMs);
      continue;
    }

    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 500)}`);
  }
  throw lastError || new Error('Anthropic API request failed after retries');
}

async function summarizeSession(filePath, { apiKey, model } = {}) {
  if (!apiKey) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY not set — required to summarize sessions'), {
      code: 'NO_API_KEY',
    });
  }
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

  const markdown = await callAnthropic({
    apiKey,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
  });

  return { markdown, truncated, cwd };
}

module.exports = {
  extractTranscript,
  summarizeSession,
  DEFAULT_MODEL,
  TRUNCATE_CHARS,
};
