'use strict';

async function loadAutomationStatus() {
  const status = await window.CSK.fetchJson('/api/status');
  window.CSK.renderCleanupBanner(status.cleanupPeriodDays);

  const a = status.automation;
  const grid = document.getElementById('automationGrid');
  grid.innerHTML = '';
  const rows = [
    ['Installed', a.installed ? 'yes' : 'no — click Install below', a.installed ? 'ok' : 'danger'],
    ['Currently running', a.installed ? a.state : '—'],
    ['Runs so far', a.installed ? String(a.runs) : '—'],
    ['Last exit code', a.installed ? String(a.lastExitCode) : '—', a.installed ? (a.lastExitCode === 0 ? 'ok' : 'danger') : ''],
    ['Last mirror sync', window.CSK.fmtWhen(a.lastMirrorRunAt)],
    ['Next mirror sync (estimated)', window.CSK.fmtWhen(a.estimatedNextMirrorRunAt)],
    ['Last dated snapshot', window.CSK.fmtWhen(a.lastSnapshotAt)],
    ['Next dated snapshot (estimated)', window.CSK.fmtWhen(a.estimatedNextSnapshotAt)],
  ];
  for (const [label, value, cls] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (cls) dd.className = cls;
    grid.append(dt, dd);
  }

  document.getElementById('cleanupPeriodInput').value = status.cleanupPeriodDays;
  document.getElementById('cfgKeepCount').value = status.config.keepCount;
  document.getElementById('cfgIntervalDays').value = status.config.intervalDays;
  document.getElementById('cfgContextWindow').value = status.config.contextWindowTokens;
  document.getElementById('cfgModel').value = status.config.summarizeModel;
}

async function installAutomation() {
  const btn = document.getElementById('installAutomationBtn');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    const result = await window.CSK.fetchJson('/api/automation/install', { method: 'POST' });
    const el = document.getElementById('automationOutput');
    el.hidden = false;
    el.textContent = `exit ${result.code}\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`;
    await loadAutomationStatus();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Install / reinstall automation';
  }
}

async function saveCleanupPeriod() {
  const days = Number(document.getElementById('cleanupPeriodInput').value);
  if (!confirm(`Set Claude Code's cleanupPeriodDays to ${days}? This edits ~/.claude/settings.json directly (a timestamped backup is kept first).`)) return;
  try {
    await window.CSK.fetchJson('/api/cleanup-period', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    await loadAutomationStatus();
  } catch (err) {
    alert(err.message);
  }
}

async function saveConfig() {
  const body = {
    keepCount: Number(document.getElementById('cfgKeepCount').value),
    intervalDays: Number(document.getElementById('cfgIntervalDays').value),
    contextWindowTokens: Number(document.getElementById('cfgContextWindow').value),
    summarizeModel: document.getElementById('cfgModel').value.trim(),
  };
  try {
    await window.CSK.fetchJson('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadAutomationStatus();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('installAutomationBtn').addEventListener('click', installAutomation);
document.getElementById('saveCleanupPeriodBtn').addEventListener('click', saveCleanupPeriod);
document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);

loadAutomationStatus();
