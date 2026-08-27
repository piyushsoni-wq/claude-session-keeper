'use strict';

// IIFE — see the comment at the top of backups.js: classic <script>
// tags share one top-level scope, so each tab script needs its own
// function scope to avoid colliding on names like `icon`.
(function automationTab() {
const { icon, escapeHtml, fetchJson, fmtWhen, renderCleanupBanner, hintHtml, loadingBlock, withLoading } = window.CSK;

function initStaticLabels() {
  document.getElementById('automationHeading').innerHTML = `${icon('power')} Automation`;
  document.getElementById('automationHint').innerHTML = hintHtml('gear', `Whether the scheduled backup job is actually loaded, and roughly when it'll next run. launchd itself doesn't expose an exact "next run" time for this kind of job (checked directly) — the estimate below is computed from the last completed run, not a guarantee. Confirmed separately: if your laptop is asleep at the scheduled time, the missed run fires on wake; if it's fully powered off, this job's <code>RunAtLoad</code> setting fires it at your next login instead — both cases are already covered.`);

  document.getElementById('cleanupHeading').innerHTML = `${icon('gear')} Cleanup period`;
  document.getElementById('cleanupHint').innerHTML = hintHtml('gear', `<code>cleanupPeriodDays</code> in <code>~/.claude/settings.json</code> — Claude Code's own setting for how old a session can get before it deletes it on startup. Raising this doesn't replace backups: real Claude Code GitHub issues report cleanup sometimes deleting sessions <em>newer</em> than configured; an unbounded period means unbounded local disk growth with no compression; and it only guards Claude Code's own automatic sweep, not you or a script accidentally deleting a project folder. This edits the file directly — a timestamped backup is kept before every change.`);
  const saveCleanupBtn = document.getElementById('saveCleanupPeriodBtn');
  saveCleanupBtn.innerHTML = `${icon('check')} Save`;
  saveCleanupBtn.title = 'Write this value to ~/.claude/settings.json (a backup is kept first)';

  document.getElementById('configHeading').innerHTML = `${icon('gear')} Config`;
  document.getElementById('configHint').innerHTML = hintHtml('gear', `This tool's own settings (<code>config.json</code>), separate from Claude Code's settings above. Worth knowing: backups currently live on this same disk — they protect against Claude Code's cleanup and human error, not disk failure or a lost machine.`);
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  saveConfigBtn.innerHTML = `${icon('check')} Save`;
  saveConfigBtn.title = 'Write these values to config.json';

  const installBtn = document.getElementById('installAutomationBtn');
  installBtn.innerHTML = `${icon('power')} Install / start`;
  installBtn.title = 'Load the scheduled backup job and run it once to verify';

  const stopBtn = document.getElementById('stopAutomationBtn');
  stopBtn.innerHTML = `${icon('power')} Stop`;
  stopBtn.title = 'Unload the scheduled backup job — stays installed, restart any time';
}

function showAutomationOutput(result) {
  const el = document.getElementById('automationOutput');
  el.hidden = false;
  el.textContent = `exit ${result.code}\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`;
}

async function loadAutomationStatus() {
  document.getElementById('automationGrid').innerHTML = loadingBlock('Loading automation status…');
  const status = await fetchJson('/api/status');
  renderCleanupBanner(status.cleanupPeriodDays);

  const a = status.automation;
  const grid = document.getElementById('automationGrid');
  grid.innerHTML = '';
  const stateLabel = a.installed
    ? `<span class="pill ${a.state === 'running' ? 'accent' : 'ok'}">${escapeHtml(a.state)}</span>`
    : '<span class="pill danger">not installed</span>';
  const exitLabel = a.installed
    ? `<span class="pill ${a.lastExitCode === 0 ? 'ok' : 'danger'}">${a.lastExitCode}</span>`
    : '—';
  const rows = [
    ['Status', stateLabel],
    ['Runs so far', a.installed ? String(a.runs) : '—'],
    ['Last exit code', exitLabel],
    ['Last mirror sync', fmtWhen(a.lastMirrorRunAt)],
    ['Next mirror sync (estimated)', fmtWhen(a.estimatedNextMirrorRunAt)],
    ['Last dated snapshot', fmtWhen(a.lastSnapshotAt)],
    ['Next dated snapshot (estimated)', fmtWhen(a.estimatedNextSnapshotAt)],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.innerHTML = value;
    grid.append(dt, dd);
  }

  document.getElementById('installAutomationBtn').hidden = a.installed;
  document.getElementById('stopAutomationBtn').hidden = !a.installed;

  document.getElementById('cleanupPeriodInput').value = status.cleanupPeriodDays;
  document.getElementById('cfgKeepCount').value = status.config.keepCount;
  document.getElementById('cfgIntervalDays').value = status.config.intervalDays;
  document.getElementById('cfgContextWindow').value = status.config.contextWindowTokens;
  document.getElementById('cfgModel').value = status.config.summarizeModel;
  document.getElementById('cfgExcludePatterns').value = (status.config.titleExcludePatterns || []).join('\n');
}

async function installAutomation() {
  const btn = document.getElementById('installAutomationBtn');
  await withLoading(btn, 'Installing…', async () => {
    try {
      const result = await fetchJson('/api/automation/install', { method: 'POST' });
      showAutomationOutput(result);
      await loadAutomationStatus();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function stopAutomation() {
  if (!confirm("Stop the scheduled backup job? It stays installed but won't run again until you start it.")) return;
  const btn = document.getElementById('stopAutomationBtn');
  await withLoading(btn, 'Stopping…', async () => {
    try {
      const result = await fetchJson('/api/automation/stop', { method: 'POST' });
      showAutomationOutput(result);
      await loadAutomationStatus();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function saveCleanupPeriod() {
  const days = Number(document.getElementById('cleanupPeriodInput').value);
  if (!confirm(`Set Claude Code's cleanupPeriodDays to ${days}? This edits ~/.claude/settings.json directly (a timestamped backup is kept first).`)) return;
  const btn = document.getElementById('saveCleanupPeriodBtn');
  await withLoading(btn, 'Saving…', async () => {
    try {
      await fetchJson('/api/cleanup-period', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
      });
      await loadAutomationStatus();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function saveConfig() {
  const patterns = document.getElementById('cfgExcludePatterns').value
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const body = {
    keepCount: Number(document.getElementById('cfgKeepCount').value),
    intervalDays: Number(document.getElementById('cfgIntervalDays').value),
    contextWindowTokens: Number(document.getElementById('cfgContextWindow').value),
    summarizeModel: document.getElementById('cfgModel').value.trim(),
    titleExcludePatterns: patterns,
  };
  const btn = document.getElementById('saveConfigBtn');
  await withLoading(btn, 'Saving…', async () => {
    try {
      await fetchJson('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await loadAutomationStatus();
      if (window.CSK.onConfigSaved) window.CSK.onConfigSaved();
    } catch (err) {
      alert(err.message);
    }
  });
}

initStaticLabels();
document.getElementById('installAutomationBtn').addEventListener('click', installAutomation);
document.getElementById('stopAutomationBtn').addEventListener('click', stopAutomation);
document.getElementById('saveCleanupPeriodBtn').addEventListener('click', saveCleanupPeriod);
document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);

loadAutomationStatus();
})();
