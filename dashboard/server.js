'use strict';

// Zero-dependency Node http server — no npm install needed to run this.
// Static assets are vanilla JS/CSS in dashboard/public/.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const sessions = require('../lib/sessions');
const summarize = require('../lib/summarize');
const claudeSettings = require('../lib/claude-settings');
const automation = require('../lib/automation');
const backups = require('../lib/backups');
const unifiedSessions = require('../lib/unified-sessions');
const { shQuote, asQuote } = require('../lib/shell');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
const PORT = Number(process.env.PORT) || 4317;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB — plenty for config/session-id payloads

const DEFAULT_CONFIG = {
  keepCount: 6,
  intervalDays: 15,
  contextWindowTokens: 1000000,
  summarizeModel: 'sonnet',
  // Title patterns hidden from the default sessions view (searching for
  // a match still shows them — see dashboard/public/backups.js). Started
  // as a narrow, user-editable stopgap for an unrelated PR-review bot's
  // auto-generated sessions; not a general automation/prevention feature.
  titleExcludePatterns: ['^Review \\d+ changed file'],
};

function getBackupRoot() {
  return process.env.CLAUDE_SESSION_KEEPER_BACKUP_ROOT || path.join(os.homedir(), 'claude-session-keeper-backups');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(partial) {
  const merged = { ...readConfig(), ...partial };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/backups.js': { file: 'backups.js', type: 'application/javascript; charset=utf-8' },
  '/automation.js': { file: 'automation.js', type: 'application/javascript; charset=utf-8' },
};

function serveStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  const filePath = path.join(PUBLIC_DIR, entry.file);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 500, `Failed to read ${entry.file}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(data);
  });
  return true;
}

function runScript(scriptRelPath, args) {
  return new Promise((resolve) => {
    const scriptPath = path.join(REPO_ROOT, scriptRelPath);
    execFile('bash', [scriptPath, ...args], { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || '').slice(-8000),
        stderr: String(stderr || '').slice(-4000),
      });
    });
  });
}

// macOS Automation permission denials surface through osascript's stderr/
// error message (classic error -1743). Callers can't fix this from the
// dashboard — surface it as an actionable message instead of a raw error.
function isAutomationPermissionError(message) {
  return /not authorized|-1743|osascript is not allowed/i.test(message || '');
}

// Shared by "Open" (resume an existing session) and "Continue" (open a
// fresh one seeded with a resume-brief) — both are just "run this shell
// command in Terminal, in this directory."
function runInTerminal(cwd, innerCommand) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve({ ok: false, error: 'This action is macOS-only (uses osascript + Terminal.app).' });
      return;
    }
    const shellCommand = `cd ${shQuote(cwd)} && ${innerCommand}`;
    const appleScript = `tell application "Terminal"\nactivate\ndo script ${asQuote(shellCommand)}\nend tell`;
    // Argument array + no shell:true — osascript receives the whole
    // AppleScript string as one argv entry, so there's no third,
    // Node-level shell-interpretation layer to worry about.
    execFile('osascript', ['-e', appleScript], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message || '');
        if (isAutomationPermissionError(message)) {
          resolve({
            ok: false,
            error:
              'macOS blocked this. Grant Terminal automation access: System Settings → Privacy & Security → Automation → (this app) → Terminal.',
          });
          return;
        }
        resolve({ ok: false, error: message.slice(0, 500) || 'osascript failed' });
        return;
      }
      resolve({ ok: true });
    });
  });
}

function openSessionInTerminal(cwd, sessionId) {
  return runInTerminal(cwd, `claude --resume ${shQuote(sessionId)}`);
}

// Confirmed by actually running this (not assumed): passing a multi-
// line brief directly as `claude '<brief>'` is NOT a correctness bug —
// shQuote/asQuote round-trip it byte-for-byte, and Claude Code receives
// and responds to the full, correct text. But `do script` "types" the
// whole command into Terminal, and a single-quoted argument spanning
// many physical lines makes the shell show its normal multi-line-quote
// continuation prompt for each line while it's "typed" — looks like a
// stuck/broken shell even though it resolves correctly once the quote
// closes. Writing the brief to a temp file and typing only
// `claude "$(cat file)"` keeps the visibly-typed command to one short
// line; the multi-line content is substituted in by the shell itself,
// invisibly. Cleanup runs after claude exits (`;`, not `&&`, so it
// still happens even if the user Ctrl-Cs out).
function continueSessionInTerminal(cwd, brief) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-continue-'));
  const briefFile = path.join(tmpDir, 'brief.txt');
  fs.writeFileSync(briefFile, brief, 'utf8');
  const innerCommand = `claude "$(cat ${shQuote(briefFile)})" ; rm -rf ${shQuote(tmpDir)}`;
  return runInTerminal(cwd, innerCommand);
}

// Resolves a session to a real file on disk, honoring the same
// live > mirror > newest-snapshot priority as everything else. When the
// only copy is inside a snapshot, extracts it to a temp dir — caller
// must remove the returned tmpDir (null when no extraction happened).
function resolveSessionFilePath(backupRoot, sessionId) {
  const liveFile = sessions.findSessionFile(sessionId);
  if (liveFile) return { filePath: liveFile, tmpDir: null };

  const mirrorFile = sessions.findSessionFileIn(backups.mirrorDir(backupRoot), sessionId);
  if (mirrorFile) return { filePath: mirrorFile, tmpDir: null };

  for (const snap of backups.listSnapshots(backupRoot)) {
    if (backups.listSnapshotSessionIds(backupRoot, snap.file).includes(sessionId)) {
      const extracted = backups.extractSessionFromSnapshot(backupRoot, snap.file, sessionId);
      if (extracted) return extracted;
    }
  }
  return { filePath: null, tmpDir: null };
}

async function handleApi(req, res, pathname, query) {
  const config = readConfig();
  const backupRoot = getBackupRoot();

  if (pathname === '/api/status' && req.method === 'GET') {
    const mirrorDir = backups.mirrorDir(backupRoot);
    const snapshots = backups.listSnapshots(backupRoot);
    const latestSnapshot = snapshots.length > 0
      ? { file: snapshots[0].file, ageDays: Math.floor((Date.now() - snapshots[0].mtimeMs) / 86400000) }
      : null;

    sendJson(res, 200, {
      projectsDir: sessions.projectsDir(),
      cleanupPeriodDays: claudeSettings.readCleanupPeriodDays(),
      backupRoot,
      mirrorExists: fs.existsSync(mirrorDir),
      latestSnapshot,
      automation: automation.getAutomationStatus(backupRoot, config.intervalDays),
      config,
    });
    return;
  }

  if (pathname === '/api/cleanup-period' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const days = claudeSettings.writeCleanupPeriodDays(body.days);
      sendJson(res, 200, { cleanupPeriodDays: days });
    } catch (err) {
      sendError(res, 400, err.message);
    }
    return;
  }

  if (pathname === '/api/automation/install' && req.method === 'POST') {
    const result = await runScript('scripts/install-launchd.sh', []);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (pathname === '/api/automation/stop' && req.method === 'POST') {
    const result = await runScript('scripts/stop-launchd.sh', []);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (pathname === '/api/backup' && req.method === 'POST') {
    const result = await runScript('backup.sh', []);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (pathname === '/api/restore' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const args = [];
    if (body.mirror) {
      args.push('--mirror');
    } else if (body.latest) {
      args.push('--latest');
    } else if (body.file) {
      args.push(String(body.file));
    } else {
      sendError(res, 400, 'Provide { mirror: true }, { latest: true }, or { file: "<archive-path>" }');
      return;
    }
    if (body.target) {
      args.push('--target', String(body.target));
    }
    const result = await runScript('restore.sh', args);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (pathname === '/api/restore-session' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId;
    if (!sessions.isSafeSessionId(sessionId)) {
      sendError(res, 400, 'Invalid sessionId');
      return;
    }
    let sourceArg;
    if (body.source === 'mirror') {
      sourceArg = 'mirror';
    } else if (backups.SNAPSHOT_NAME_RE.test(String(body.source || ''))) {
      sourceArg = path.join(backups.snapshotsDir(backupRoot), body.source);
    } else {
      sendError(res, 400, 'source must be "mirror" or a valid snapshot filename');
      return;
    }
    const result = await runScript('restore.sh', ['--session', sessionId, '--source', sourceArg]);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const allowed = ['keepCount', 'intervalDays', 'contextWindowTokens', 'summarizeModel', 'titleExcludePatterns'];
    const partial = {};
    for (const key of allowed) {
      if (key in body) partial[key] = body[key];
    }
    const merged = writeConfig(partial);
    sendJson(res, 200, { config: merged });
    return;
  }

  if (pathname === '/api/sessions/delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.sessionIds) ? body.sessionIds : [];
    const results = { succeeded: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        sessions.deleteSessionIn(sessions.projectsDir(), id);
        results.succeeded += 1;
      } catch (err) {
        results.failed += 1;
        results.errors.push({ sessionId: id, error: err.message });
      }
    }
    sendJson(res, 200, results);
    return;
  }

  if (pathname === '/api/sessions/rename' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId;
    const liveFile = sessions.isSafeSessionId(sessionId) ? sessions.findSessionFile(sessionId) : null;
    const targetRoot = liveFile ? sessions.projectsDir() : backups.mirrorDir(backupRoot);
    try {
      const title = sessions.writeSessionTitle(targetRoot, sessionId, body.title);
      sendJson(res, 200, { title });
    } catch (err) {
      sendError(res, 400, err.message);
    }
    return;
  }

  if (pathname === '/api/sessions/continue' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId;
    if (!sessions.isSafeSessionId(sessionId)) {
      sendError(res, 400, 'Invalid sessionId');
      return;
    }
    const { filePath, tmpDir } = resolveSessionFilePath(backupRoot, sessionId);
    if (!filePath) {
      sendError(res, 404, `Session ${sessionId} not found`);
      return;
    }
    try {
      const cwd = sessions.resolveSessionCwd(filePath);
      if (!cwd) {
        sendError(res, 422, 'Could not resolve this session\'s working directory from its transcript.');
        return;
      }
      if (!fs.existsSync(cwd)) {
        sendError(res, 422, `This session's original directory no longer exists on disk: ${cwd}`);
        return;
      }
      const { markdown } = await summarize.summarizeSession(filePath, { model: config.summarizeModel });
      const result = await continueSessionInTerminal(cwd, markdown);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (err) {
      sendError(res, 502, err.message);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  if (pathname === '/api/backups/unified-sessions' && req.method === 'GET') {
    sendJson(res, 200, { sessions: unifiedSessions.listUnifiedSessions(backupRoot, { contextWindowTokens: config.contextWindowTokens }) });
    return;
  }

  if (pathname === '/api/backups/snapshots' && req.method === 'GET') {
    sendJson(res, 200, { snapshots: backups.listSnapshots(backupRoot) });
    return;
  }

  if (pathname === '/api/backups/snapshot-sessions' && req.method === 'GET') {
    const file = query.get('file');
    const result = backups.listSnapshotSessions(backupRoot, String(file || ''));
    if (result === null) {
      sendError(res, 404, `Snapshot not found: ${file}`);
      return;
    }
    sendJson(res, 200, { sessions: result });
    return;
  }

  if (pathname === '/api/backups/delete-snapshot' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      backups.deleteSnapshot(backupRoot, String(body.file || ''));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 400, err.message);
    }
    return;
  }

  if (pathname === '/api/backups/delete-mirror-session' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      backups.deleteMirrorSession(backupRoot, String(body.sessionId || ''));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 400, err.message);
    }
    return;
  }

  if (pathname === '/api/open-session' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId;
    if (!sessionId) {
      sendError(res, 400, 'sessionId required');
      return;
    }
    const filePath = sessions.findSessionFile(sessionId);
    if (!filePath) {
      sendError(res, 404, `Session ${sessionId} not found`);
      return;
    }
    const cwd = sessions.resolveSessionCwd(filePath);
    if (!cwd) {
      sendError(res, 422, 'Could not resolve this session\'s working directory from its transcript.');
      return;
    }
    const result = await openSessionInTerminal(cwd, sessionId);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  sendError(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, url.searchParams).catch((err) => {
      sendError(res, err.statusCode || 500, err.message || 'Internal error');
    });
    return;
  }

  if (req.method === 'GET' && serveStatic(res, pathname)) return;

  sendError(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`claude-session-keeper dashboard: http://localhost:${PORT}`);
});
