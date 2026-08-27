'use strict';

// Flat-file summary storage: one markdown file per session plus a JSON
// index. Deliberately not a vector DB — real semantic search needs an
// embeddings model (no public Anthropic embeddings endpoint), which means
// a third-party API or a local model: a real dependency/cost decision, not
// something to add silently. Search here is keyword substring only.

const fs = require('fs');
const path = require('path');

function summariesDir(repoRoot) {
  return path.join(repoRoot, 'summaries');
}

function indexPath(repoRoot) {
  return path.join(summariesDir(repoRoot), 'index.json');
}

function readIndex(repoRoot) {
  try {
    const raw = fs.readFileSync(indexPath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

function writeIndex(repoRoot, entries) {
  fs.mkdirSync(summariesDir(repoRoot), { recursive: true });
  fs.writeFileSync(indexPath(repoRoot), JSON.stringify(entries, null, 2), 'utf8');
}

function summaryFilePath(repoRoot, sessionId) {
  return path.join(summariesDir(repoRoot), `${sessionId}.md`);
}

function saveSummary(repoRoot, { sessionId, cwd, markdown, truncated, generatedAt }) {
  fs.mkdirSync(summariesDir(repoRoot), { recursive: true });
  fs.writeFileSync(summaryFilePath(repoRoot, sessionId), markdown, 'utf8');

  const entries = readIndex(repoRoot).filter((e) => e.sessionId !== sessionId);
  entries.push({
    sessionId,
    cwd: cwd || null,
    truncated: !!truncated,
    generatedAt: generatedAt || new Date().toISOString(),
    // First line (after any heading marker) as a cheap list-view preview.
    preview: (markdown.split('\n').find((l) => l.trim().length > 0) || '').slice(0, 200),
  });
  writeIndex(repoRoot, entries);
  return entries[entries.length - 1];
}

function getSummary(repoRoot, sessionId) {
  try {
    return fs.readFileSync(summaryFilePath(repoRoot, sessionId), 'utf8');
  } catch {
    return null;
  }
}

function listSummaries(repoRoot) {
  return readIndex(repoRoot).sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}

// Case-insensitive substring match over the stored markdown content plus
// cwd/sessionId. Not fuzzy, not ranked beyond match count — deliberate,
// see module comment above.
function searchSummaries(repoRoot, query) {
  const needle = String(query || '').toLowerCase().trim();
  if (!needle) return listSummaries(repoRoot);

  const results = [];
  for (const entry of readIndex(repoRoot)) {
    const haystackParts = [entry.sessionId, entry.cwd || ''];
    const markdown = getSummary(repoRoot, entry.sessionId) || '';
    haystackParts.push(markdown);
    const haystack = haystackParts.join('\n').toLowerCase();
    if (haystack.includes(needle)) {
      results.push(entry);
    }
  }
  return results.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}

module.exports = {
  summariesDir,
  saveSummary,
  getSummary,
  listSummaries,
  searchSummaries,
};
