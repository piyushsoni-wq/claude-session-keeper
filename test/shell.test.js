'use strict';

// Round-trips shQuote/asQuote through the REAL interpreters they target
// (bash, and osascript's AppleScript parser) rather than eyeballing the
// escaping logic — the PRD this repo was rebuilt from flagged a real bug
// in this exact spot that only surfaced under that kind of test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const { shQuote, asQuote } = require('../lib/shell');

const ADVERSARIAL_STRINGS = [
  '',
  'plain',
  '   leading and trailing spaces   ',
  "it's a test",
  "multiple ' quotes ' in ' one string",
  '$HOME and `date` and $(whoami)',
  'back\\slash\\here',
  'line1\nline2\nline3',
  '"double quotes" too',
  "'''",
  'mixed \'"$`\\ everything at once',
];

for (const input of ADVERSARIAL_STRINGS) {
  test(`shQuote round-trips through real bash: ${JSON.stringify(input)}`, () => {
    const quoted = shQuote(input);
    const output = execFileSync('bash', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
    assert.equal(output, input);
  });
}

if (process.platform === 'darwin') {
  for (const input of ADVERSARIAL_STRINGS) {
    test(`asQuote round-trips through real osascript: ${JSON.stringify(input)}`, () => {
      const quoted = asQuote(input);
      // osascript appends exactly one trailing newline after the result;
      // strip only that one before comparing.
      const output = execFileSync('osascript', ['-e', `return ${quoted}`], { encoding: 'utf8' });
      assert.equal(output.endsWith('\n') ? output.slice(0, -1) : output, input);
    });
  }
} else {
  test('asQuote/osascript round-trip skipped — not on macOS', () => {
    assert.ok(true);
  });
}
