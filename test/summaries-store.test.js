'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/summaries-store');

function tmpRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csk-store-'));
}

test('saveSummary writes a markdown file and an index entry', () => {
  const repoRoot = tmpRepoRoot();
  const entry = store.saveSummary(repoRoot, {
    sessionId: 'abc123',
    cwd: '/Users/test/project',
    markdown: '# Resume brief\n\nDid some work on the widget.',
    truncated: false,
  });
  assert.equal(entry.sessionId, 'abc123');
  assert.equal(fs.existsSync(path.join(repoRoot, 'summaries', 'abc123.md')), true);
  assert.equal(store.getSummary(repoRoot, 'abc123'), '# Resume brief\n\nDid some work on the widget.');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('saveSummary overwrites an existing entry for the same session', () => {
  const repoRoot = tmpRepoRoot();
  store.saveSummary(repoRoot, { sessionId: 'dup', markdown: 'first version' });
  store.saveSummary(repoRoot, { sessionId: 'dup', markdown: 'second version' });
  const all = store.listSummaries(repoRoot);
  assert.equal(all.filter((e) => e.sessionId === 'dup').length, 1);
  assert.equal(store.getSummary(repoRoot, 'dup'), 'second version');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('searchSummaries matches by substring in markdown content, case-insensitive', () => {
  const repoRoot = tmpRepoRoot();
  store.saveSummary(repoRoot, { sessionId: 'a', markdown: 'Fixed the widget coupon lock bug.', cwd: '/repo/a' });
  store.saveSummary(repoRoot, { sessionId: 'b', markdown: 'Unrelated GST rounding work.', cwd: '/repo/b' });

  const results = store.searchSummaries(repoRoot, 'COUPON');
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, 'a');

  const noMatch = store.searchSummaries(repoRoot, 'nonexistent-term');
  assert.equal(noMatch.length, 0);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('getSummary returns null for an unknown session', () => {
  const repoRoot = tmpRepoRoot();
  assert.equal(store.getSummary(repoRoot, 'nope'), null);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
