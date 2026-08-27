'use strict';

// Shared helpers used by every tab script (live-sessions.js, backups.js,
// automation.js, summaries.js) — loaded first, exposes everything on
// window.CSK. No framework, no build step: script tags execute in
// document order, so by the time each tab script runs, window.CSK is
// already populated.

window.CSK = {};

window.CSK.fetchJson = async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
};

// User-controlled text (session titles, cwd paths) ends up interpolated
// into innerHTML templates throughout the tab scripts — escape it first
// so an oddly-titled session can't inject markup.
window.CSK.escapeHtml = function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
};

window.CSK.fmtBytes = function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

window.CSK.fmtAgo = function fmtAgo(mtimeMs) {
  const mins = Math.floor((Date.now() - mtimeMs) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

// Same threshold/estimate framing whether ago is null (unknown launchd
// timestamp) or a real ISO string.
window.CSK.fmtWhen = function fmtWhen(iso) {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleString();
};

window.CSK.usageBarHtml = function usageBarHtml(session) {
  if (session.contextUnknown || session.contextRatio == null) {
    return '<span class="usage-bar"></span><span>unknown</span>';
  }
  const pct = Math.min(100, Math.round(session.contextRatio * 100));
  const cls = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : '';
  return `<span class="usage-bar"><span class="usage-bar-fill ${cls}" style="width:${pct}%"></span></span><span>${pct}%</span>`;
};

window.CSK.titleCellHtml = function titleCellHtml(session) {
  const esc = window.CSK.escapeHtml;
  const title = session.title || `(untitled) ${session.sessionId.slice(0, 8)}`;
  return `<span class="title">${esc(title)}</span><span class="id">${esc(session.sessionId.slice(0, 8))}</span>`;
};

// ---- Pagination (shared by live sessions, mirror sessions, snapshots, summaries) ----

window.CSK.createPager = function createPager(pageSize) {
  return { page: 1, pageSize, items: [] };
};

window.CSK.pageSlice = function pageSlice(pager) {
  const start = (pager.page - 1) * pager.pageSize;
  return pager.items.slice(start, start + pager.pageSize);
};

window.CSK.totalPages = function totalPages(pager) {
  return Math.max(1, Math.ceil(pager.items.length / pager.pageSize));
};

window.CSK.renderPagerControls = function renderPagerControls(el, pager, onChange) {
  const total = pager.items.length;
  el.innerHTML = '';
  if (total === 0) {
    const empty = document.createElement('span');
    empty.className = 'pager-info';
    empty.textContent = 'No items.';
    el.appendChild(empty);
    return;
  }
  const pages = window.CSK.totalPages(pager);
  if (pager.page > pages) pager.page = pages;
  const start = (pager.page - 1) * pager.pageSize + 1;
  const end = Math.min(pager.page * pager.pageSize, total);

  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `Showing ${start}–${end} of ${total}`;

  const prev = document.createElement('button');
  prev.className = 'btn small';
  prev.textContent = '‹ Prev';
  prev.disabled = pager.page <= 1;
  prev.onclick = () => { pager.page -= 1; onChange(); };

  const pageLabel = document.createElement('span');
  pageLabel.className = 'pager-info';
  pageLabel.textContent = `Page ${pager.page} of ${pages}`;

  const next = document.createElement('button');
  next.className = 'btn small';
  next.textContent = 'Next ›';
  next.disabled = pager.page >= pages;
  next.onclick = () => { pager.page += 1; onChange(); };

  el.append(info, prev, pageLabel, next);
};

// ---- Tabs ----

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---- Cleanup-period banner (shared: shown regardless of which tab is active) ----

window.CSK.renderCleanupBanner = function renderCleanupBanner(cleanupPeriodDays) {
  const banner = document.getElementById('cleanupBanner');
  banner.hidden = false;
  banner.textContent = `Claude Code deletes sessions after ${cleanupPeriodDays} days (mtime-based, checked on every startup). Keep backups running.`;
};
