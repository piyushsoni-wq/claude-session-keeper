'use strict';

const liveSessionsPager = window.CSK.createPager(20);
const selectedLiveIds = new Set();
const RECENTLY_MODIFIED_MS = 5 * 60 * 1000;

async function loadLiveSessions() {
  const { sessions } = await window.CSK.fetchJson('/api/live-sessions');
  liveSessionsPager.items = sessions;
  liveSessionsPager.page = 1;
  selectedLiveIds.clear();
  renderLiveSessionsPage();
  updateBulkBar();
}

function renderLiveSessionsPage() {
  const body = document.getElementById('sessionsBody');
  body.innerHTML = '';
  const pageItems = window.CSK.pageSlice(liveSessionsPager);
  for (const s of pageItems) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="checkbox-col"><input type="checkbox" class="row-select" ${selectedLiveIds.has(s.sessionId) ? 'checked' : ''} /></td>
      <td class="title-cell">${window.CSK.titleCellHtml(s)}</td>
      <td class="cwd" title="${window.CSK.escapeHtml(s.cwd || '')}">${window.CSK.escapeHtml(s.cwd || '(unknown)')}</td>
      <td>${window.CSK.fmtAgo(s.mtimeMs)} · ${window.CSK.fmtBytes(s.sizeBytes)}</td>
      <td>${window.CSK.usageBarHtml(s)}</td>
      <td class="actions"></td>
    `;

    tr.querySelector('.row-select').addEventListener('change', (e) => {
      if (e.target.checked) selectedLiveIds.add(s.sessionId);
      else selectedLiveIds.delete(s.sessionId);
      updateSelectAllState();
      updateBulkBar();
    });

    const actionsTd = tr.querySelector('.actions');

    const openBtn = document.createElement('button');
    openBtn.className = 'btn small';
    openBtn.textContent = 'Open';
    openBtn.onclick = () => openSession(s.sessionId, openBtn);

    const sumBtn = document.createElement('button');
    sumBtn.className = 'btn small';
    sumBtn.textContent = 'Summarize';
    sumBtn.onclick = () => summarizeOneLive(s.sessionId, sumBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = () => {
      const label = s.title || s.sessionId.slice(0, 8);
      const warn = recentWarning([s]);
      deleteLiveSessions([s.sessionId], `Delete session "${label}"? This removes it from ~/.claude/projects.${warn}`);
    };

    actionsTd.append(openBtn, sumBtn, delBtn);
    body.appendChild(tr);
  }
  window.CSK.renderPagerControls(document.getElementById('sessionsPager'), liveSessionsPager, renderLiveSessionsPage);
  updateSelectAllState();
}

function recentWarning(items) {
  const recent = items.some((s) => Date.now() - s.mtimeMs < RECENTLY_MODIFIED_MS);
  return recent ? '\n\n⚠️ At least one of these was modified in the last 5 minutes — it might be an open Claude Code session right now.' : '';
}

function updateSelectAllState() {
  const selectAll = document.getElementById('selectAllSessions');
  const pageItems = window.CSK.pageSlice(liveSessionsPager);
  selectAll.checked = pageItems.length > 0 && pageItems.every((s) => selectedLiveIds.has(s.sessionId));
}

function updateBulkBar() {
  const bulkBtn = document.getElementById('bulkDeleteBtn');
  const countEl = document.getElementById('bulkSelectedCount');
  bulkBtn.disabled = selectedLiveIds.size === 0;
  countEl.textContent = selectedLiveIds.size > 0 ? `${selectedLiveIds.size} selected` : '';
}

async function openSession(sessionId, btn) {
  btn.disabled = true;
  try {
    await window.CSK.fetchJson('/api/open-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function summarizeOneLive(sessionId, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '…';
  try {
    await window.CSK.fetchJson('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (window.CSK.refreshSummaries) window.CSK.refreshSummaries();
    alert('Summarized — see the Summaries tab.');
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function deleteLiveSessions(sessionIds, confirmMessage) {
  if (!confirm(confirmMessage)) return;
  try {
    const result = await window.CSK.fetchJson('/api/sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds }),
    });
    if (result.failed > 0) {
      alert(`Deleted ${result.succeeded}, failed ${result.failed}:\n${result.errors.map((e) => `${e.sessionId}: ${e.error}`).join('\n')}`);
    }
    sessionIds.forEach((id) => selectedLiveIds.delete(id));
    await loadLiveSessions();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('refreshSessionsBtn').addEventListener('click', loadLiveSessions);

document.getElementById('selectAllSessions').addEventListener('change', (e) => {
  const pageItems = window.CSK.pageSlice(liveSessionsPager);
  if (e.target.checked) pageItems.forEach((s) => selectedLiveIds.add(s.sessionId));
  else pageItems.forEach((s) => selectedLiveIds.delete(s.sessionId));
  renderLiveSessionsPage();
  updateBulkBar();
});

document.getElementById('bulkDeleteBtn').addEventListener('click', () => {
  const ids = Array.from(selectedLiveIds);
  const selectedItems = liveSessionsPager.items.filter((s) => selectedLiveIds.has(s.sessionId));
  deleteLiveSessions(ids, `Delete ${ids.length} selected session(s)? This removes them from ~/.claude/projects.${recentWarning(selectedItems)}`);
});

loadLiveSessions();
