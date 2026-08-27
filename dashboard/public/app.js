'use strict';

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtAgo(mtimeMs) {
  const mins = Math.floor((Date.now() - mtimeMs) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function showScriptOutput(result) {
  const el = document.getElementById('scriptOutput');
  el.hidden = false;
  el.textContent = `exit ${result.code}\n${result.stdout}${result.stderr ? '\n--- stderr ---\n' + result.stderr : ''}`;
}

// ---- Status ----

async function loadStatus() {
  const status = await fetchJson('/api/status');
  const banner = document.getElementById('cleanupBanner');
  if (status.cleanupPeriodDays <= 30) {
    banner.hidden = false;
    banner.textContent = `Claude Code deletes sessions after ${status.cleanupPeriodDays} days (mtime-based). Keep backups running.`;
  } else {
    banner.hidden = true;
  }

  const grid = document.getElementById('statusGrid');
  grid.innerHTML = '';
  const rows = [
    ['Projects dir', status.projectsDir],
    ['Cleanup period', `${status.cleanupPeriodDays} days`],
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

  document.getElementById('cfgKeepCount').value = status.config.keepCount;
  document.getElementById('cfgIntervalDays').value = status.config.intervalDays;
  document.getElementById('cfgContextWindow').value = status.config.contextWindowTokens;
  document.getElementById('cfgModel').value = status.config.summarizeModel;
}

// ---- Sessions ----

function usageBarHtml(session) {
  if (session.contextUnknown || session.contextRatio == null) {
    return '<span class="usage-bar"></span><span>unknown</span>';
  }
  const pct = Math.min(100, Math.round(session.contextRatio * 100));
  const cls = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : '';
  return `<span class="usage-bar"><span class="usage-bar-fill ${cls}" style="width:${pct}%"></span></span><span>${pct}%</span>`;
}

async function loadSessions() {
  const { sessions } = await fetchJson('/api/live-sessions');
  const body = document.getElementById('sessionsBody');
  body.innerHTML = '';
  for (const s of sessions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${s.sessionId.slice(0, 8)}</code></td>
      <td class="cwd" title="${s.cwd || ''}">${s.cwd || '(unknown)'}</td>
      <td>${fmtAgo(s.mtimeMs)} · ${fmtBytes(s.sizeBytes)}</td>
      <td>${usageBarHtml(s)}</td>
      <td></td>
    `;
    const actionsTd = tr.lastElementChild;

    const openBtn = document.createElement('button');
    openBtn.className = 'btn';
    openBtn.textContent = 'Open';
    openBtn.onclick = () => openSession(s.sessionId, openBtn);

    const sumBtn = document.createElement('button');
    sumBtn.className = 'btn';
    sumBtn.textContent = 'Summarize';
    sumBtn.onclick = () => summarizeOne(s.sessionId, sumBtn);

    actionsTd.append(openBtn, sumBtn);
    body.appendChild(tr);
  }
}

async function openSession(sessionId, btn) {
  btn.disabled = true;
  try {
    await fetchJson('/api/open-session', {
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

// ---- Backup / restore ----

async function runBackup() {
  const btn = document.getElementById('backupNowBtn');
  btn.disabled = true;
  btn.textContent = 'Backing up…';
  try {
    const result = await fetchJson('/api/backup', { method: 'POST' });
    showScriptOutput(result);
    await loadStatus();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run backup now';
  }
}

async function runRestore(body) {
  const target = document.getElementById('restoreTarget').value.trim();
  if (target) body.target = target;
  try {
    const result = await fetchJson('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    showScriptOutput(result);
  } catch (err) {
    alert(err.message);
  }
}

// ---- Config ----

async function saveConfig() {
  const body = {
    keepCount: Number(document.getElementById('cfgKeepCount').value),
    intervalDays: Number(document.getElementById('cfgIntervalDays').value),
    contextWindowTokens: Number(document.getElementById('cfgContextWindow').value),
    summarizeModel: document.getElementById('cfgModel').value.trim(),
  };
  try {
    await fetchJson('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadStatus();
  } catch (err) {
    alert(err.message);
  }
}

// ---- Summaries ----

async function loadSummaries(query) {
  const url = query ? `/api/summaries?q=${encodeURIComponent(query)}` : '/api/summaries';
  const { summaries } = await fetchJson(url);
  const list = document.getElementById('summariesList');
  list.innerHTML = '';
  for (const s of summaries) {
    const li = document.createElement('li');
    li.innerHTML = `<div>${s.sessionId.slice(0, 8)} — ${s.preview || '(empty)'}</div>
      <div class="meta">${s.cwd || 'unknown dir'} · ${new Date(s.generatedAt).toLocaleString()}${s.truncated ? ' · truncated' : ''}</div>`;
    li.onclick = () => showSummary(s.sessionId);
    list.appendChild(li);
  }
}

async function showSummary(sessionId) {
  const detail = document.getElementById('summaryDetail');
  detail.hidden = false;
  detail.textContent = 'Loading…';
  try {
    const { markdown } = await fetchJson(`/api/summaries?id=${encodeURIComponent(sessionId)}`);
    detail.textContent = markdown;
  } catch (err) {
    detail.textContent = err.message;
  }
}

async function summarizeOne(sessionId, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await fetchJson('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    await loadSummaries(document.getElementById('summarySearch').value.trim());
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Summarize';
  }
}

async function summarizeAll() {
  const btn = document.getElementById('summarizeAllBtn');
  btn.disabled = true;
  btn.textContent = 'Summarizing…';
  try {
    const result = await fetchJson('/api/summarize-all', { method: 'POST' });
    alert(`Summarized ${result.succeeded}, failed ${result.failed}.`);
    await loadSummaries();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Summarize all live sessions';
  }
}

// ---- Wiring ----

document.getElementById('backupNowBtn').addEventListener('click', runBackup);
document.getElementById('restoreMirrorBtn').addEventListener('click', () => runRestore({ mirror: true }));
document.getElementById('restoreLatestBtn').addEventListener('click', () => runRestore({ latest: true }));
document.getElementById('refreshSessionsBtn').addEventListener('click', loadSessions);
document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
document.getElementById('summarizeAllBtn').addEventListener('click', summarizeAll);
document.getElementById('summarySearch').addEventListener('input', (e) => loadSummaries(e.target.value.trim()));

loadStatus();
loadSessions();
loadSummaries();
