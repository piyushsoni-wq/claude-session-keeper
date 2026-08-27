'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { extractTranscript, stripWrappingCodeFence, TRUNCATE_CHARS } = require('../lib/summarize');

const FIXTURES = path.join(__dirname, 'fixtures');

test('extractTranscript pulls text blocks and tool-call breadcrumbs, skips tool_result noise', () => {
  const { text, truncated, cwd } = extractTranscript(path.join(FIXTURES, 'tool-use-session.jsonl'));
  assert.equal(cwd, '/Users/test/tool-project');
  assert.equal(truncated, false);
  assert.match(text, /Fix the bug in auth\.js/);
  assert.match(text, /Let me look at the file\./);
  assert.match(text, /\[tool call: Read\]/);
  assert.match(text, /Found it, fixed the null check\./);
  // tool_result content itself shouldn't appear — it's the noisy half of
  // a tool round-trip, intentionally omitted (see lib/summarize.js).
  assert.doesNotMatch(text, /file contents/);
});

test('stripWrappingCodeFence removes a full-response ```markdown fence', () => {
  const wrapped = '```markdown\n# Resume Brief\n\nsome content\n```';
  assert.equal(stripWrappingCodeFence(wrapped), '# Resume Brief\n\nsome content');
});

test('stripWrappingCodeFence removes a bare ``` fence with no language tag', () => {
  const wrapped = '```\n# Heading\nbody\n```';
  assert.equal(stripWrappingCodeFence(wrapped), '# Heading\nbody');
});

test('stripWrappingCodeFence leaves unwrapped markdown untouched', () => {
  const plain = '# Heading\n\nSome text with an inline `code` span, not a wrapper.';
  assert.equal(stripWrappingCodeFence(plain), plain);
});

test('stripWrappingCodeFence leaves markdown with an embedded (not wrapping) code block untouched', () => {
  const withEmbedded = '# Heading\n\nHere is a snippet:\n\n```js\nconst x = 1;\n```\n\nMore text after.';
  assert.equal(stripWrappingCodeFence(withEmbedded), withEmbedded);
});

test('extractTranscript fails soft on a missing file', () => {
  const { text, truncated, cwd } = extractTranscript(path.join(FIXTURES, 'does-not-exist.jsonl'));
  assert.equal(text, '');
  assert.equal(truncated, false);
  assert.equal(cwd, null);
});

test('extractTranscript truncates to the most recent TRUNCATE_CHARS characters', () => {
  const fs = require('fs');
  const os = require('os');
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csk-transcript-')), 'big.jsonl');

  // Build a transcript well over the truncation limit, with a
  // recognizable marker only in the final turn.
  const lines = [];
  for (let i = 0; i < 2000; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { content: `filler turn ${i} `.repeat(20) } }));
  }
  lines.push(JSON.stringify({ type: 'assistant', message: { content: 'FINAL_MARKER_TURN' } }));
  fs.writeFileSync(tmpFile, lines.join('\n'));

  const { text, truncated } = extractTranscript(tmpFile);
  assert.equal(truncated, true);
  assert.ok(text.length <= TRUNCATE_CHARS);
  assert.match(text, /FINAL_MARKER_TURN/);
  assert.doesNotMatch(text, /filler turn 0 /);

  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
});
