'use strict';

const mirrorPager = window.CSK.createPager(20);
const snapshotsPager = window.CSK.createPager(20);

// ---- Backup status card ----

async function loadBackupStatus() {
  const status = await window.CSK.fetchJson('/api/status');
  window.CSK.renderCleanupBanner(status.cleanupPeriodDays);

  const grid = document.getElementById('statusGrid');
  grid.innerHTML = '';
  const rows = [
    ['Projects dir', status.projectsDir],
    ['Backup root', status.backupRoot],
    ['Mirror', status.mirrorExists ? 'present' : 'not yet created'],
    ['Latest snapshot', status.latestSnapshot ? `${status.latestSnapshot.file} (${status.latestSnapshot.ageDays}d old)` : 'none yet'],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    grid.append(dt, dd);
  }
}

function showScriptOutput(result) {
  const el = document.getElementById('scriptOutput');
  el.hidden = false;
  el.textContent = `exit ${result.code}\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`;
}

async function runBackup() {
  const btn = document.getElementById('backupNowBtn');
  btn.disabled = true;
  btn.textContent = 'Backing up…';
  try {
    const result = await window.CSK.fetchJson('/api/backup', { method: 'POST' });
    showScriptOutput(result);
    await loadBackupStatus();
    await loadMirrorSessions();
    await loadSnapshots();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run backup now';
  }
}

// ---- Mirror contents ----

async function loadMirrorSessions() {
  const { sessions } = await window.CSK.fetchJson('/api/backups/mirror-sessions');
  mirrorPager.items = sessions;
  mirrorPager.page = 1;
  renderMirrorPage();
}

function renderMirrorPage() {
  const body = document.getElementById('mirrorBody');
  body.innerHTML = '';
  for (const s of window.CSK.pageSlice(mirrorPager)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="title-cell">${window.CSK.titleCellHtml(s)}</td>
      <td class="cwd" title="${window.CSK.escapeHtml(s.cwd || '')}">${window.CSK.escapeHtml(s.cwd || '(unknown)')}</td>
      <td>${window.CSK.fmtAgo(s.mtimeMs)} · ${window.CSK.fmtBytes(s.sizeBytes)}</td>
      <td class="actions"></td>
    `;
    const actionsTd = tr.querySelector('.actions');

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn small';
    restoreBtn.textContent = 'Restore';
    restoreBtn.onclick = () => restoreSession(s.sessionId, 'mirror', restoreBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      if (!confirm(`Remove "${s.title || s.sessionId.slice(0, 8)}" from the mirror? It'll still be in any dated snapshot that already captured it.`)) return;
      try {
        await window.CSK.fetchJson('/api/backups/delete-mirror-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: s.sessionId }),
        });
        await loadMirrorSessions();
      } catch (err) {
        alert(err.message);
      }
    };

    actionsTd.append(restoreBtn, delBtn);
    body.appendChild(tr);
  }
  window.CSK.renderPagerControls(document.getElementById('mirrorPager'), mirrorPager, renderMirrorPage);
}

async function restoreSession(sessionId, source, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '…';
  try {
    const result = await window.CSK.fetchJson('/api/restore-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, source }),
    });
    showScriptOutput(result);
    alert('Restored to ~/.claude/projects (its timestamp was refreshed so it survives the next cleanup).');
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---- Dated snapshots ----

async function loadSnapshots() {
  const { snapshots } = await window.CSK.fetchJson('/api/backups/snapshots');
  snapshotsPager.items = snapshots;
  snapshotsPager.page = 1;
  renderSnapshotsPage();
}

function renderSnapshotsPage() {
  const body = document.getElementById('snapshotsBody');
  body.innerHTML = '';
  for (const snap of window.CSK.pageSlice(snapshotsPager)) {
    const tr = document.createElement('tr');
    const ageDays = Math.floor((Date.now() - snap.mtimeMs) / 86400000);
    tr.innerHTML = `
      <td><code>${window.CSK.escapeHtml(snap.file)}</code></td>
      <td>${window.CSK.fmtBytes(snap.sizeBytes)}</td>
      <td>${ageDays}d old</td>
      <td class="actions"></td>
    `;
    const actionsTd = tr.querySelector('.actions');

    const browseBtn = document.createElement('button');
    browseBtn.className = 'btn small';
    browseBtn.textContent = 'Browse';
    browseBtn.onclick = () => browseSnapshot(snap.file);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      if (!confirm(`Delete the whole snapshot "${snap.file}"? This removes every session it contains that isn't captured elsewhere. This can't be undone.`)) return;
      try {
        await window.CSK.fetchJson('/api/backups/delete-snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: snap.file }),
        });
        document.getElementById('snapshotDetail').hidden = true;
        await loadSnapshots();
      } catch (err) {
        alert(err.message);
      }
    };

    actionsTd.append(browseBtn, delBtn);
    body.appendChild(tr);
  }
  window.CSK.renderPagerControls(document.getElementById('snapshotsPager'), snapshotsPager, renderSnapshotsPage);
}

async function browseSnapshot(file) {
  const detail = document.getElementById('snapshotDetail');
  const title = document.getElementById('snapshotDetailTitle');
  const body = document.getElementById('snapshotDetailBody');
  detail.hidden = false;
  title.textContent = `Contents of ${file}`;
  body.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';

  try {
    const { sessions } = await window.CSK.fetchJson(`/api/backups/snapshot-sessions?file=${encodeURIComponent(file)}`);
    body.innerHTML = '';
    for (const s of sessions) {
      const tr = document.createElement('tr');
      const label = s.title || s.sessionId.slice(0, 8);
      tr.innerHTML = `
        <td>${window.CSK.escapeHtml(label)}</td>
        <td class="cwd" title="${window.CSK.escapeHtml(s.cwd || '')}">${window.CSK.escapeHtml(s.cwd || '(unknown)')}</td>
        <td class="actions"></td>
      `;
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn small';
      restoreBtn.textContent = 'Restore';
      restoreBtn.onclick = () => restoreSession(s.sessionId, file, restoreBtn);
      tr.querySelector('.actions').appendChild(restoreBtn);
      body.appendChild(tr);
    }
    if (sessions.length === 0) {
      body.innerHTML = '<tr><td colspan="3">No sessions found in this snapshot.</td></tr>';
    }
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3">${window.CSK.escapeHtml(err.message)}</td></tr>`;
  }
}

document.getElementById('backupNowBtn').addEventListener('click', runBackup);

loadBackupStatus();
loadMirrorSessions();
loadSnapshots();
