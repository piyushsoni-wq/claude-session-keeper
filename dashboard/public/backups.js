'use strict';

// IIFE: backups.js and automation.js are both plain classic <script>
// tags (no type="module"), which share ONE top-level lexical scope in
// the browser — a bare top-level `const icon = ...` in both files
// collides ("Identifier 'icon' has already been declared"), confirmed
// by actually loading the page. Wrapping each file's body gives it a
// private function scope instead.
(function backupsTab() {
const {
  icon, escapeHtml, fetchJson, fmtBytes, fmtAgo, createPager, pageSlice, renderPagerControls,
  emptyState, renderCleanupBanner, hintHtml, loadingRow, loadingBlock, withLoading, withLoadingIcon, tooltip,
} = window.CSK;

const sessionsPager = createPager(20);
const snapshotsPager = createPager(20);
const selectedIds = new Set();

let allSessions = [];
let excludePatterns = [];
let currentSearch = '';

// ---- Static labels (icon + text set once, keeps index.html markup-free of icon strings) ----

function initStaticLabels() {
  document.getElementById('backupStatusHeading').innerHTML = `${icon('archive')} Backup status`;
  const backupNowBtn = document.getElementById('backupNowBtn');
  backupNowBtn.innerHTML = `${icon('refresh')} Run backup now`;
  tooltip(backupNowBtn, "Mirror live sessions now, and cut a new dated snapshot if it's due");
  document.getElementById('backupStatusHint').innerHTML = hintHtml('gear', `Mirrors <code>~/.claude/projects</code> now, and cuts a new dated snapshot if <code>intervalDays</code> has passed since the last one. The mirror only updates when a backup actually runs — this button, the daily automation, or at login — not continuously.`);

  document.getElementById('sessionsHeading').innerHTML = `${icon('search')} Sessions`;
  const refreshBtn = document.getElementById('refreshSessionsBtn');
  refreshBtn.innerHTML = `${icon('refresh')} Refresh`;
  tooltip(refreshBtn, 'Reload the sessions table');
  document.getElementById('sessionsHint').innerHTML = hintHtml('gear', 'Every session this tool knows about — live, mirrored, or only inside a snapshot — merged into one row per session. Badges show where each currently exists.');

  document.getElementById('snapshotsHeading').innerHTML = `${icon('archive')} Dated snapshots`;
  document.getElementById('snapshotsHint').innerHTML = hintHtml('gear', 'Immutable point-in-time archives, kept up to <code>keepCount</code> of them. Deleting a session from the mirror never removes it from a snapshot that already captured it.');

  const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
  bulkDeleteBtn.innerHTML = `${icon('delete')} Delete selected`;
  tooltip(bulkDeleteBtn, 'Delete every checked session from wherever it currently exists (live and/or mirror)');

  tooltip(document.getElementById('selectAllSessions'), 'Select every session on this page');

  const searchBox = document.querySelector('#tab-backups .search-box');
  searchBox.innerHTML = `${icon('search', 14)}<input type="text" id="sessionsSearch" placeholder="search sessions… (also reveals hidden noise)" />`;
  tooltip(document.getElementById('sessionsSearch'), 'Also reveals sessions hidden by titleExcludePatterns');
  document.getElementById('sessionsSearch').addEventListener('input', (e) => {
    currentSearch = e.target.value;
    applyFilterAndRender();
  });
}

// ---- Backup status card ----

async function loadBackupStatus() {
  document.getElementById('statusGrid').innerHTML = loadingBlock('Loading backup status…');
  const status = await fetchJson('/api/status');
  renderCleanupBanner(status.cleanupPeriodDays);

  const grid = document.getElementById('statusGrid');
  grid.innerHTML = '';
  const rows = [
    ['Projects dir', status.projectsDir],
    ['Backup root', status.backupRoot],
    ['Mirror', status.mirrorExists ? '<span class="pill ok">present</span>' : '<span class="pill neutral">not yet created</span>'],
    ['Latest snapshot', status.latestSnapshot ? `${escapeHtml(status.latestSnapshot.file)} · ${status.latestSnapshot.ageDays}d old` : '<span class="pill neutral">none yet</span>'],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.innerHTML = value;
    grid.append(dt, dd);
  }

  excludePatterns = (status.config.titleExcludePatterns || [])
    .map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } })
    .filter(Boolean);
}

function showScriptOutput(result) {
  const el = document.getElementById('scriptOutput');
  el.hidden = false;
  el.textContent = `exit ${result.code}\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`;
}

async function runBackup() {
  const btn = document.getElementById('backupNowBtn');
  await withLoading(btn, 'Backing up…', async () => {
    try {
      const result = await fetchJson('/api/backup', { method: 'POST' });
      showScriptOutput(result);
      await Promise.all([loadBackupStatus(), loadSessions(), loadSnapshots()]);
    } catch (err) {
      alert(err.message);
    }
  });
}

// ---- Unified sessions table ----

async function loadSessions() {
  document.getElementById('sessionsBody').innerHTML = loadingRow(7, 'Loading sessions…');
  const { sessions } = await fetchJson('/api/backups/unified-sessions');
  allSessions = sessions;
  applyFilterAndRender();
}

function matchesExclude(row) {
  return excludePatterns.some((re) => re.test(row.title || ''));
}

function applyFilterAndRender() {
  const q = currentSearch.trim().toLowerCase();
  let filtered;
  if (q) {
    // Search overrides the default exclude — this is how existing noise
    // (e.g. the PR-review bot's sessions) gets found for bulk cleanup.
    filtered = allSessions.filter((r) => (r.title || '').toLowerCase().includes(q)
      || (r.cwd || '').toLowerCase().includes(q)
      || r.sessionId.toLowerCase().includes(q));
  } else {
    filtered = allSessions.filter((r) => !matchesExclude(r));
  }
  sessionsPager.items = filtered;
  sessionsPager.page = 1;
  renderSessionsPage();
}

function badgesHtml(row) {
  const parts = [];
  if (row.inLive) parts.push('<span class="pill ok">Live</span>');
  if (row.inMirror) parts.push('<span class="pill accent">Mirror</span>');
  if (row.inSnapshots.length > 0) {
    parts.push(`<span class="pill neutral">${row.inSnapshots.length} snapshot${row.inSnapshots.length > 1 ? 's' : ''}</span>`);
  }
  return `<div class="badge-row">${parts.join('')}</div>`;
}

function usageCellHtml(row) {
  if (row.contextUnknown || row.contextRatio == null) return '<span class="usage-cell">—</span>';
  const pct = Math.min(100, Math.round(row.contextRatio * 100));
  const cls = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : '';
  return `<span class="usage-cell"><span class="usage-bar"><span class="usage-bar-fill ${cls}" style="width:${pct}%"></span></span>${pct}%</span>`;
}

// Every row action (Open/Continue/Rename/Restore/Delete/Browse) is async
// and can take real time — Continue especially, a real `claude -p` call
// (15-20+ seconds observed) that previously gave zero feedback while it
// ran. Wrapping here once means every call site gets the busy-spinner
// treatment for free, without each one remembering to add it.
function actionBtn(iconName, label, onClick, extraClass) {
  const b = document.createElement('button');
  b.className = `btn ghost small${extraClass ? ` ${extraClass}` : ''}`;
  tooltip(b, label);
  b.innerHTML = icon(iconName);
  b.onclick = () => withLoadingIcon(b, onClick);
  return b;
}

function renderSessionsPage() {
  const body = document.getElementById('sessionsBody');
  body.innerHTML = '';
  const pageItems = pageSlice(sessionsPager);

  if (allSessions.length === 0) {
    body.innerHTML = `<tr><td colspan="7">${emptyState('No sessions yet — run a backup to get started.')}</td></tr>`;
  } else if (pageItems.length === 0) {
    body.innerHTML = `<tr><td colspan="7">${emptyState('Nothing matches your search.')}</td></tr>`;
  }

  for (const row of pageItems) {
    const tr = document.createElement('tr');
    const label = row.title || `(untitled) ${row.sessionId.slice(0, 8)}`;
    const whenLabel = row.snapshotOnly ? `as of snapshot · ${fmtAgo(row.mtimeMs)}` : fmtAgo(row.mtimeMs);
    tr.innerHTML = `
      <td class="checkbox-col"><input type="checkbox" class="row-select" data-tooltip="Select this session" ${selectedIds.has(row.sessionId) ? 'checked' : ''} /></td>
      <td class="title-cell"><span class="title">${escapeHtml(label)}</span><span class="id">${escapeHtml(row.sessionId.slice(0, 8))}</span></td>
      <td class="cwd" data-tooltip="${escapeHtml(row.cwd || '')}">${escapeHtml(row.cwd || '(unknown)')}</td>
      <td>${whenLabel}${row.sizeBytes != null ? ` · ${fmtBytes(row.sizeBytes)}` : ''}</td>
      <td>${badgesHtml(row)}</td>
      <td>${usageCellHtml(row)}</td>
      <td class="actions"></td>
    `;

    tr.querySelector('.row-select').addEventListener('change', (e) => {
      if (e.target.checked) selectedIds.add(row.sessionId);
      else selectedIds.delete(row.sessionId);
      updateSelectAllState();
      updateBulkBar();
    });

    const actionsTd = tr.querySelector('.actions');
    if (row.inLive) actionsTd.appendChild(actionBtn('open', 'Open', () => openSession(row)));
    actionsTd.appendChild(actionBtn('continue', 'Continue with a fresh session', () => continueSession(row)));
    if (row.inLive || row.inMirror) actionsTd.appendChild(actionBtn('rename', 'Rename', () => renameSession(row)));
    if (!row.inLive) actionsTd.appendChild(actionBtn('restore', 'Restore', () => restoreSession(row)));
    if (row.inLive || row.inMirror) actionsTd.appendChild(actionBtn('delete', 'Delete', () => deleteSession(row), 'danger'));

    body.appendChild(tr);
  }
  renderPagerControls(document.getElementById('sessionsPager'), sessionsPager, renderSessionsPage);
  updateSelectAllState();
  updateBulkBar();
}

function updateSelectAllState() {
  const selectAll = document.getElementById('selectAllSessions');
  const pageItems = pageSlice(sessionsPager);
  selectAll.checked = pageItems.length > 0 && pageItems.every((r) => selectedIds.has(r.sessionId));
}

function updateBulkBar() {
  const bulkBtn = document.getElementById('bulkDeleteBtn');
  const countEl = document.getElementById('bulkSelectedCount');
  const selectAllMatchingBtn = document.getElementById('selectAllMatchingBtn');

  bulkBtn.disabled = selectedIds.size === 0;
  countEl.textContent = selectedIds.size > 0 ? `${selectedIds.size} selected` : '';

  const filteredCount = sessionsPager.items.length;
  const allFilteredSelected = filteredCount > 0 && sessionsPager.items.every((r) => selectedIds.has(r.sessionId));
  const pageItems = pageSlice(sessionsPager);
  if (filteredCount > pageItems.length && !allFilteredSelected) {
    selectAllMatchingBtn.hidden = false;
    selectAllMatchingBtn.textContent = `Select all ${filteredCount} matching`;
    tooltip(selectAllMatchingBtn, 'Select every session matching the current search, not just this page');
  } else {
    selectAllMatchingBtn.hidden = true;
  }
}

// ---- Row actions ----

async function openSession(row) {
  try {
    await fetchJson('/api/open-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: row.sessionId }),
    });
  } catch (err) {
    alert(err.message);
  }
}

async function continueSession(row) {
  const label = row.title || row.sessionId.slice(0, 8);
  const proceed = confirm(
    `Generate a resume-brief for "${label}" and open a NEW Claude Code session in ${row.cwd} seeded with it?\n\nThis session (if it exists live) is left completely untouched — nothing is deleted.`,
  );
  if (!proceed) return;
  try {
    const result = await fetchJson('/api/sessions/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: row.sessionId }),
    });
    if (!result.ok) alert(result.error || 'Failed to continue this session.');
  } catch (err) {
    alert(err.message);
  }
}

async function renameSession(row) {
  if (row.snapshotOnly) {
    alert('This session only exists in a snapshot (immutable) — restore it first, then rename.');
    return;
  }
  const current = row.title || '';
  const next = prompt('New title:', current);
  if (next === null || next.trim() === '' || next === current) return;
  try {
    await fetchJson('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: row.sessionId, title: next }),
    });
    await loadSessions();
  } catch (err) {
    alert(err.message);
  }
}

async function restoreSession(row) {
  const source = row.inMirror ? 'mirror' : row.inSnapshots[0];
  const sourceLabel = row.inMirror ? 'the mirror' : `snapshot "${row.inSnapshots[0]}"`;
  const label = row.title || row.sessionId.slice(0, 8);
  const proceed = confirm(
    `Restore "${label}" from ${sourceLabel} into ~/.claude/projects?\n\nThis never overwrites an existing live file — it only fills in what's missing, and its timestamp is refreshed so Claude Code's cleanup won't immediately delete it again.`,
  );
  if (!proceed) return;
  try {
    const result = await fetchJson('/api/restore-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: row.sessionId, source }),
    });
    showScriptOutput(result);
    await loadSessions();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteSessionIds(ids, confirmMessage) {
  if (!confirm(confirmMessage)) return;
  const targets = allSessions.filter((r) => ids.includes(r.sessionId));
  let succeeded = 0;
  const errors = [];
  for (const row of targets) {
    try {
      if (row.inLive) {
        await fetchJson('/api/sessions/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionIds: [row.sessionId] }),
        });
      }
      if (row.inMirror) {
        await fetchJson('/api/backups/delete-mirror-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: row.sessionId }),
        });
      }
      succeeded += 1;
    } catch (err) {
      errors.push(`${row.sessionId.slice(0, 8)}: ${err.message}`);
    }
  }
  if (errors.length > 0) alert(`Deleted ${succeeded}, failed ${errors.length}:\n${errors.join('\n')}`);
  ids.forEach((id) => selectedIds.delete(id));
  await loadSessions();
}

function deleteSession(row) {
  const label = row.title || row.sessionId.slice(0, 8);
  const where = [row.inLive && 'the live directory', row.inMirror && 'the mirror'].filter(Boolean).join(' and ');
  const recent = Date.now() - (row.mtimeMs || 0) < 5 * 60 * 1000
    ? '\n\n⚠️ Modified in the last 5 minutes — might be an open Claude Code session right now.'
    : '';
  deleteSessionIds(
    [row.sessionId],
    `Delete "${label}" from ${where}? Any snapshot that already has it keeps its own copy regardless.${recent}`,
  );
}

// ---- Snapshots management ----

async function loadSnapshots() {
  document.getElementById('snapshotsBody').innerHTML = loadingRow(4, 'Loading snapshots…');
  const { snapshots } = await fetchJson('/api/backups/snapshots');
  snapshotsPager.items = snapshots;
  snapshotsPager.page = 1;
  renderSnapshotsPage();
}

function renderSnapshotsPage() {
  const body = document.getElementById('snapshotsBody');
  body.innerHTML = '';
  const pageItems = pageSlice(snapshotsPager);
  if (snapshotsPager.items.length === 0) {
    body.innerHTML = `<tr><td colspan="4">${emptyState('No snapshots yet — run a backup to cut the first one.')}</td></tr>`;
  }
  for (const snap of pageItems) {
    const tr = document.createElement('tr');
    const ageDays = Math.floor((Date.now() - snap.mtimeMs) / 86400000);
    tr.innerHTML = `
      <td><code>${escapeHtml(snap.file)}</code></td>
      <td>${fmtBytes(snap.sizeBytes)}</td>
      <td>${ageDays}d old</td>
      <td class="actions"></td>
    `;
    const actionsTd = tr.querySelector('.actions');
    actionsTd.appendChild(actionBtn('search', 'Browse contents', () => browseSnapshot(snap.file)));
    actionsTd.appendChild(actionBtn('delete', 'Delete this snapshot', async () => {
      if (!confirm(`Delete the whole snapshot "${snap.file}"? This can't be undone. Sessions that also exist live or in the mirror are unaffected.`)) return;
      try {
        await fetchJson('/api/backups/delete-snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: snap.file }),
        });
        document.getElementById('snapshotDetail').hidden = true;
        await Promise.all([loadSnapshots(), loadSessions()]);
      } catch (err) {
        alert(err.message);
      }
    }, 'danger'));
    body.appendChild(tr);
  }
  renderPagerControls(document.getElementById('snapshotsPager'), snapshotsPager, renderSnapshotsPage);
}

async function browseSnapshot(file) {
  const detail = document.getElementById('snapshotDetail');
  const title = document.getElementById('snapshotDetailTitle');
  const body = document.getElementById('snapshotDetailBody');
  detail.hidden = false;
  title.innerHTML = `${icon('archive', 13)} Contents of ${escapeHtml(file)}`;
  body.innerHTML = loadingRow(3, 'Loading snapshot contents…');

  try {
    const { sessions } = await fetchJson(`/api/backups/snapshot-sessions?file=${encodeURIComponent(file)}`);
    body.innerHTML = '';
    if (sessions.length === 0) {
      body.innerHTML = `<tr><td colspan="3">${emptyState('No sessions found in this snapshot.')}</td></tr>`;
      return;
    }
    for (const s of sessions) {
      const tr = document.createElement('tr');
      const label = s.title || s.sessionId.slice(0, 8);
      tr.innerHTML = `
        <td>${escapeHtml(label)}</td>
        <td class="cwd" data-tooltip="${escapeHtml(s.cwd || '')}">${escapeHtml(s.cwd || '(unknown)')}</td>
        <td class="actions"></td>
      `;
      tr.querySelector('.actions').appendChild(actionBtn('restore', 'Restore from this snapshot', () => restoreSession({
        sessionId: s.sessionId, title: s.title, inMirror: false, inSnapshots: [file],
      })));
      body.appendChild(tr);
    }
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---- Wiring ----

initStaticLabels();

document.getElementById('backupNowBtn').addEventListener('click', runBackup);
document.getElementById('refreshSessionsBtn').addEventListener('click', (e) => withLoading(e.currentTarget, 'Refreshing…', loadSessions));

document.getElementById('selectAllSessions').addEventListener('change', (e) => {
  const pageItems = pageSlice(sessionsPager);
  if (e.target.checked) pageItems.forEach((r) => selectedIds.add(r.sessionId));
  else pageItems.forEach((r) => selectedIds.delete(r.sessionId));
  renderSessionsPage();
});

document.getElementById('selectAllMatchingBtn').addEventListener('click', () => {
  sessionsPager.items.forEach((r) => selectedIds.add(r.sessionId));
  renderSessionsPage();
});

document.getElementById('bulkDeleteBtn').addEventListener('click', (e) => {
  const ids = Array.from(selectedIds);
  const msg = `Delete ${ids.length} selected session(s)? Each is removed from wherever it currently is (live and/or mirror) — snapshots already containing them are unaffected.`;
  // deleteSessionIds's own confirm() ends up inside the busy-button
  // window (the button shows a spinner while the modal dialog waits for
  // a response) — harmless, since a native confirm() blocks everything
  // else anyway, and it keeps this one call site consistent with how
  // every row action already wraps confirm+work together.
  withLoading(e.currentTarget, 'Deleting…', () => deleteSessionIds(ids, msg));
});

// titleExcludePatterns lives in config.json, edited on the Automation
// tab — when it's saved there, this tab's filtering needs to pick up
// the new patterns without requiring a manual refresh here too.
window.CSK.onConfigSaved = () => { loadBackupStatus().then(applyFilterAndRender); };

loadBackupStatus().then(loadSessions);
loadSnapshots();
})();
