'use strict';

// Guard for test environments
const chromeAvailable = typeof chrome !== 'undefined' && chrome.runtime;

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function formatHours(hours) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return 'less than 1 hour';
  if (hours === 1) return '1 hour';
  if (hours < 24) return `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

function renderStats(stats) {
  document.getElementById('stat-keys').textContent =
    stats.totalKeys != null ? stats.totalKeys : '—';
  document.getElementById('stat-age').textContent =
    stats.layer2Age != null ? formatHours(stats.layer2Age) + ' ago' : 'Not loaded';
  document.getElementById('stat-expires').textContent =
    stats.layer2ExpiresIn != null ? formatHours(stats.layer2ExpiresIn) : '—';
}

function loadStats() {
  if (!chromeAvailable) return;
  document.getElementById('status').textContent = 'Loading…';
  chrome.runtime.sendMessage({ action: 'GET_CACHE_STATS' }, (stats) => {
    if (chrome.runtime.lastError) {
      document.getElementById('status').textContent = 'Could not reach background.';
      return;
    }
    renderStats(stats || {});
    document.getElementById('status').textContent = '';
  });
}

function clearCache() {
  if (!chromeAvailable) return;
  document.getElementById('status').textContent = 'Clearing…';
  chrome.runtime.sendMessage({ action: 'CLEAR_CACHE' }, (result) => {
    if (chrome.runtime.lastError) {
      document.getElementById('status').textContent = 'Error clearing cache.';
      return;
    }
    showToast(`Cleared ${result?.cleared ?? 0} cached entries`);
    document.getElementById('status').textContent = '';
    loadStats();
  });
}

// Set version from manifest
if (chromeAvailable) {
  const manifest = chrome.runtime.getManifest();
  const vEl = document.getElementById('version');
  if (vEl) vEl.textContent = `v${manifest.version}`;
}

document.getElementById('btn-clear')?.addEventListener('click', clearCache);
document.getElementById('btn-refresh')?.addEventListener('click', loadStats);

// Load stats on open
loadStats();
