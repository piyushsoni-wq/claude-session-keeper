'use strict';

// Shared helpers used by both tab scripts (backups.js, automation.js) —
// loaded first, exposes everything on window.CSK. No framework, no
// build step: script tags execute in document order, so by the time
// each tab script runs, window.CSK is already populated.

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
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

window.CSK.fmtAgo = function fmtAgo(mtimeMs) {
  if (mtimeMs == null) return 'unknown';
  const mins = Math.floor((Date.now() - mtimeMs) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

window.CSK.fmtWhen = function fmtWhen(iso) {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleString();
};

// ---- Icons (inline SVG, currentColor, no external deps) ----

const ICONS = {
  open: '<path d="M7 3H3v10h10v-4M9 3h4v4M13 3 7 9"/>',
  continue: '<path d="M4 3l9 5-9 5V3z"/>',
  restore: '<path d="M3 8a5 5 0 1 1 1.5 3.5M3 8V4M3 8h4"/>',
  rename: '<path d="M11 2l3 3-8 8-3.5.5.5-3.5 8-8z"/>',
  delete: '<path d="M3 4h10M6 4V2.5h4V4M4.5 4l.5 9.5h6l.5-9.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M13 13l-2.5-2.5"/>',
  refresh: '<path d="M3 8a5 5 0 0 1 8.5-3.5M13 4v3h-3M13 8a5 5 0 0 1-8.5 3.5M3 12V9h3"/>',
  archive: '<rect x="2" y="3" width="12" height="3"/><path d="M3 6v7h10V6M6.5 9h3"/>',
  gear: '<circle cx="8" cy="8" r="2.3"/><path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1"/>',
  power: '<path d="M8 2v6"/><path d="M5 4a5 5 0 1 0 6 0"/>',
  check: '<path d="M3 8l3.5 3.5L13 5"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
};

window.CSK.icon = function icon(name, size) {
  const px = size || 14;
  const body = ICONS[name] || '';
  return `<svg class="icon" width="${px}" height="${px}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
};

// Sets the custom CSS tooltip (see [data-tooltip] in style.css) instead
// of the native `title` attribute — reported directly as not visible
// (native tooltips are slow and inconsistent across browsers). Also sets
// aria-label so screen readers still get the explanation.
window.CSK.tooltip = function tooltip(el, text) {
  el.dataset.tooltip = text;
  el.setAttribute('aria-label', text);
  return el;
};

// ---- Pagination (shared across every list) ----

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
  if (total === 0) return;
  const pages = window.CSK.totalPages(pager);
  if (pager.page > pages) pager.page = pages;
  const start = (pager.page - 1) * pager.pageSize + 1;
  const end = Math.min(pager.page * pager.pageSize, total);

  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `${start}–${end} of ${total}`;

  const prev = document.createElement('button');
  prev.className = 'btn ghost small';
  window.CSK.tooltip(prev, 'Previous page');
  prev.innerHTML = window.CSK.icon('chevron').replace('viewBox="0 0 16 16"', 'viewBox="0 0 16 16" style="transform:rotate(180deg)"');
  prev.disabled = pager.page <= 1;
  prev.onclick = () => { pager.page -= 1; onChange(); };

  const pageLabel = document.createElement('span');
  pageLabel.className = 'pager-info';
  pageLabel.textContent = `Page ${pager.page} / ${pages}`;

  const next = document.createElement('button');
  next.className = 'btn ghost small';
  window.CSK.tooltip(next, 'Next page');
  next.innerHTML = window.CSK.icon('chevron');
  next.disabled = pager.page >= pages;
  next.onclick = () => { pager.page += 1; onChange(); };

  el.append(info, prev, pageLabel, next);
};

// .hint is a flex row (icon + text). A bare icon followed by a raw text
// node — no wrapping element — is a real layout bug, not hypothetical:
// the anonymous text-node flex item doesn't wrap the way a normal block
// does, and overflows past the container instead (confirmed by actually
// rendering it). Wrapping the text in a <span> (with CSS giving it
// `flex: 1; min-width: 0`) gives flexbox a real box to shrink and wrap.
window.CSK.hintHtml = function hintHtml(iconName, html) {
  return `${window.CSK.icon(iconName, 12)}<span>${html}</span>`;
};

window.CSK.emptyState = function emptyState(message) {
  return `<div class="empty-state">${window.CSK.icon('archive', 22)}<p>${window.CSK.escapeHtml(message)}</p></div>`;
};

// ---- Loading states ----
// Every async action (initial table load, refresh, and especially
// "Continue" — a real `claude -p` call that can take 15-20+ real
// seconds — showed no busy indicator at all before this. Three shapes
// covers everywhere it's needed: a spinner glyph, a full loading row for
// tables/lists, and two button wrappers (icon-only small row actions vs.
// normal text buttons) that disable the button and swap in a spinner for
// the duration, always restoring it in a `finally` regardless of
// success or failure.

window.CSK.spinnerHtml = function spinnerHtml() {
  return '<span class="spinner"></span>';
};

window.CSK.loadingRow = function loadingRow(colspan, label) {
  return `<tr><td colspan="${colspan}" class="loading-row">${window.CSK.spinnerHtml()}${window.CSK.escapeHtml(label || 'Loading…')}</td></tr>`;
};

window.CSK.loadingBlock = function loadingBlock(label) {
  return `<div class="loading-row">${window.CSK.spinnerHtml()}${window.CSK.escapeHtml(label || 'Loading…')}</div>`;
};

// For normal-sized text buttons ("Run backup now", "Save", ...): shows
// spinner + label in place of the button's usual content.
window.CSK.withLoading = async function withLoading(btn, label, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${window.CSK.spinnerHtml()}${window.CSK.escapeHtml(label)}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

// For small icon-only row actions (Open/Continue/Rename/Restore/Delete):
// swaps just the icon for a spinner, same size, so the row doesn't
// reflow while the action is in flight.
window.CSK.withLoadingIcon = async function withLoadingIcon(btn, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = window.CSK.spinnerHtml();
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

// ---- Tabs (pill segmented control) ----

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
  banner.innerHTML = `${window.CSK.icon('gear', 13)} Claude Code deletes sessions after <strong>${cleanupPeriodDays} days</strong> (mtime-based, checked on every startup). Backups below are what actually protects you.`;
};
