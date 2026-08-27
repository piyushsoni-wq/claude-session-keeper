'use strict';

// Zero-dependency Node http server — no npm install needed to run this.
// Static assets are vanilla JS/CSS in dashboard/public/.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const sessions = require('../lib/sessions');
const summarize = require('../lib/summarize');
const summariesStore = require('../lib/summaries-store');
const { shQuote, asQuote } = require('../lib/shell');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
const PORT = Number(process.env.PORT) || 4317;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB — plenty for config/session-id payloads

const DEFAULT_CONFIG = {
  keepCount: 6,
  intervalDays: 15,
  contextWindowTokens: 200000,
  summarizeModel: 'claude-opus-5',
};

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

function runScript(scriptName, args) {
  return new Promise((resolve) => {
    const scriptPath = path.join(REPO_ROOT, scriptName);
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

function openSessionInTerminal(cwd, sessionId) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve({ ok: false, error: 'Open-in-Terminal is macOS-only (uses osascript + Terminal.app).' });
      return;
    }
    const shellCommand = `cd ${shQuote(cwd)} && claude --resume ${shQuote(sessionId)}`;
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

async function handleApi(req, res, pathname, query) {
  const config = readConfig();

  if (pathname === '/api/status' && req.method === 'GET') {
    const backupRoot = process.env.CLAUDE_SESSION_KEEPER_BACKUP_ROOT || path.join(require('os').homedir(), 'claude-session-keeper-backups');
    const mirrorDir = path.join(backupRoot, 'mirror');
    const snapshotDir = path.join(backupRoot, 'snapshots');
    let latestSnapshot = null;
    try {
      const files = fs
        .readdirSync(snapshotDir)
        .filter((f) => f.startsWith('claude-sessions-') && f.endsWith('.tar.gz'))
        .map((f) => ({ file: f, mtimeMs: fs.statSync(path.join(snapshotDir, f)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (files.length > 0) {
        latestSnapshot = {
          file: files[0].file,
          ageDays: Math.floor((Date.now() - files[0].mtimeMs) / 86400000),
        };
      }
    } catch {
      // no snapshots yet
    }
    sendJson(res, 200, {
      projectsDir: sessions.projectsDir(),
      cleanupPeriodDays: sessions.readCleanupPeriodDays(),
      backupRoot,
      mirrorExists: fs.existsSync(mirrorDir),
      latestSnapshot,
      config,
    });
    return;
  }

  if (pathname === '/api/live-sessions' && req.method === 'GET') {
    sendJson(res, 200, { sessions: sessions.listLiveSessions(config.contextWindowTokens) });
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

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const allowed = ['keepCount', 'intervalDays', 'contextWindowTokens', 'summarizeModel'];
    const partial = {};
    for (const key of allowed) {
      if (key in body) partial[key] = body[key];
    }
    const merged = writeConfig(partial);
    sendJson(res, 200, { config: merged });
    return;
  }

  if (pathname === '/api/summarize' && req.method === 'POST') {
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
    try {
      const { markdown, truncated, cwd } = await summarize.summarizeSession(filePath, {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: config.summarizeModel,
      });
      const entry = summariesStore.saveSummary(REPO_ROOT, { sessionId, cwd, markdown, truncated });
      sendJson(res, 200, { entry, markdown, truncated });
    } catch (err) {
      sendError(res, err.code === 'NO_API_KEY' ? 400 : 502, err.message);
    }
    return;
  }

  if (pathname === '/api/summarize-all' && req.method === 'POST') {
    if (!process.env.ANTHROPIC_API_KEY) {
      sendError(res, 400, 'ANTHROPIC_API_KEY not set — required to summarize sessions');
      return;
    }
    const live = sessions.listLiveSessions(config.contextWindowTokens);
    const results = { succeeded: 0, failed: 0, errors: [] };
    // Sequential on purpose — avoids hammering the API with dozens of
    // concurrent requests against a personal key's rate limit.
    for (const s of live) {
      try {
        const { markdown, truncated, cwd } = await summarize.summarizeSession(s.filePath, {
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: config.summarizeModel,
        });
        summariesStore.saveSummary(REPO_ROOT, { sessionId: s.sessionId, cwd: cwd || s.cwd, markdown, truncated });
        results.succeeded += 1;
      } catch (err) {
        results.failed += 1;
        results.errors.push({ sessionId: s.sessionId, error: err.message });
      }
    }
    sendJson(res, 200, results);
    return;
  }

  if (pathname === '/api/summaries' && req.method === 'GET') {
    const id = query.get('id');
    if (id) {
      const markdown = summariesStore.getSummary(REPO_ROOT, id);
      if (markdown === null) {
        sendError(res, 404, `No summary stored for session ${id}`);
        return;
      }
      sendJson(res, 200, { sessionId: id, markdown });
      return;
    }
    const q = query.get('q');
    const list = q ? summariesStore.searchSummaries(REPO_ROOT, q) : summariesStore.listSummaries(REPO_ROOT);
    sendJson(res, 200, { summaries: list });
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
