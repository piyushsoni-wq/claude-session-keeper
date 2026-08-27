'use strict';

const summariesPager = window.CSK.createPager(20);
let currentSummaryQuery = '';

async function loadSummaries(query) {
  currentSummaryQuery = query || '';
  const url = currentSummaryQuery ? `/api/summaries?q=${encodeURIComponent(currentSummaryQuery)}` : '/api/summaries';
  const { summaries } = await window.CSK.fetchJson(url);
  summariesPager.items = summaries;
  summariesPager.page = 1;
  renderSummariesPage();
}

function renderSummariesPage() {
  const list = document.getElementById('summariesList');
  list.innerHTML = '';
  for (const s of window.CSK.pageSlice(summariesPager)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>${window.CSK.escapeHtml(s.sessionId.slice(0, 8))} — ${window.CSK.escapeHtml(s.preview || '(empty)')}</div>
      <div class="meta">${window.CSK.escapeHtml(s.cwd || 'unknown dir')} · ${new Date(s.generatedAt).toLocaleString()}${s.truncated ? ' · truncated' : ''}</div>
    `;
    li.onclick = () => showSummary(s.sessionId);
    list.appendChild(li);
  }
  window.CSK.renderPagerControls(document.getElementById('summariesPager'), summariesPager, renderSummariesPage);
}

async function showSummary(sessionId) {
  const detail = document.getElementById('summaryDetail');
  detail.hidden = false;
  detail.textContent = 'Loading…';
  try {
    const { markdown } = await window.CSK.fetchJson(`/api/summaries?id=${encodeURIComponent(sessionId)}`);
    detail.textContent = markdown;
  } catch (err) {
    detail.textContent = err.message;
  }
}

async function summarizeAll() {
  let liveCount;
  try {
    const { sessions } = await window.CSK.fetchJson('/api/live-sessions');
    liveCount = sessions.length;
  } catch (err) {
    alert(err.message);
    return;
  }
  const proceed = confirm(
    `This runs a real "claude -p" call for each of ${liveCount} live session(s), one at a time — real usage against your plan, same as any Claude Code session. Continue?`,
  );
  if (!proceed) return;

  const btn = document.getElementById('summarizeAllBtn');
  btn.disabled = true;
  btn.textContent = 'Summarizing…';
  try {
    const result = await window.CSK.fetchJson('/api/summarize-all', { method: 'POST' });
    alert(`Summarized ${result.succeeded}, failed ${result.failed}.`);
    await loadSummaries(currentSummaryQuery);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Summarize all live sessions';
  }
}

document.getElementById('summarizeAllBtn').addEventListener('click', summarizeAll);
document.getElementById('summarySearch').addEventListener('input', (e) => loadSummaries(e.target.value.trim()));

// Called by live-sessions.js after a per-row "Summarize" so the
// Summaries tab is current without the user having to remember to
// switch tabs and refresh.
window.CSK.refreshSummaries = () => loadSummaries(currentSummaryQuery);

loadSummaries();
