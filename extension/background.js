/**
 * VoiceCast background service worker.
 *
 * All network requests pass through here. Content scripts communicate via
 * chrome.runtime.sendMessage. No in-memory state — everything rehydrates
 * from chrome.storage.local so the service worker can die and revive cleanly.
 */

// Replace with your deployed Vercel URL before shipping
const VERCEL_URL = 'https://voice-cast-eight.vercel.app';

// GitHub raw URL for Layer 2 database
const LAYER2_URL =
  'https://raw.githubusercontent.com/matanrotman/VoiceCast/main/data/database.json';

// GitHub repo root for resolving character image paths
const GITHUB_RAW_ROOT =
  'https://raw.githubusercontent.com/matanrotman/VoiceCast/main';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.warn('[VoiceCast background] Unhandled error:', err);
      sendResponse({ error: err.message });
    });
  return true; // keep channel open for async sendResponse
});

async function handleMessage(message) {
  switch (message.action) {
    case 'LOOKUP_SHOW':
      return lookupShow(message.title);
    case 'REPORT_MISSING':
      return reportMissing(message.title);
    case 'GET_CACHE_STATS':
      return getCacheStats();
    case 'CLEAR_CACHE':
      return clearCache();
    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}

// ---------------------------------------------------------------------------
// Show lookup — Layer 1 → Layer 2 → TMDB proxy
// ---------------------------------------------------------------------------

async function lookupShow(rawTitle) {
  if (!rawTitle || !rawTitle.trim()) return { found: false };

  const title = rawTitle.trim();
  const normalizedTitle = normalizeTitle(title);

  // 1. Check TMDB cache (fast path for repeat searches)
  const cached = await getCachedTmdb(normalizedTitle);
  if (cached) return cached;

  // 2. Load and merge Layer 1 + Layer 2
  const db = await getMergedDatabase();
  const match = findShow(db, normalizedTitle);

  if (match) {
    // Resolve character image URLs to absolute GitHub raw URLs
    const resolved = resolveImageUrls(match);
    return { found: true, show: resolved };
  }

  // 3. Fall back to Vercel TMDB proxy
  const tmdbResult = await fetchFromTmdbProxy(title);

  if (tmdbResult && tmdbResult.found) {
    // Cache the proxy result
    await setCachedTmdb(normalizedTitle, tmdbResult);

    // Fire off a missing-show report so the database grows
    reportMissing(title).catch(() => {}); // fire-and-forget, never throw
  }

  return tmdbResult || { found: false };
}

// ---------------------------------------------------------------------------
// Database loading and merging
// ---------------------------------------------------------------------------

async function getMergedDatabase() {
  const [layer1, layer2] = await Promise.all([loadLayer1(), loadLayer2()]);

  if (!layer2) return layer1;

  // Merge: Layer 2 wins at the show level (matched by tmdb_id)
  const merged = [...layer1];
  for (const show of layer2) {
    const idx = merged.findIndex((s) => s.tmdb_id === show.tmdb_id);
    if (idx >= 0) {
      merged[idx] = show;
    } else {
      merged.push(show);
    }
  }
  return merged;
}

async function loadLayer1() {
  try {
    const url = chrome.runtime.getURL('data/shows.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.shows || [];
  } catch (err) {
    console.warn('[VoiceCast] Failed to load Layer 1:', err);
    return [];
  }
}

async function loadLayer2() {
  // Try cache first
  const cached = await storageGet('vc_layer2_db');
  const ts = await storageGet('vc_layer2_ts');
  if (cached && ts && Date.now() - ts < CACHE_TTL_MS) {
    return cached;
  }

  // Fetch fresh
  try {
    const res = await fetch(LAYER2_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const shows = data.shows || [];
    await storageSet({ vc_layer2_db: shows, vc_layer2_ts: Date.now() });
    return shows;
  } catch (err) {
    console.warn('[VoiceCast] Failed to load Layer 2:', err);
    return null; // will fall back to Layer 1 only
  }
}

// ---------------------------------------------------------------------------
// Show matching
// ---------------------------------------------------------------------------

function findShow(shows, normalizedTitle) {
  // Exact match first
  for (const show of shows) {
    if (normalizeTitle(show.title) === normalizedTitle) return show;
  }
  // Partial match (title starts with query or vice versa)
  for (const show of shows) {
    const nt = normalizeTitle(show.title);
    if (nt.startsWith(normalizedTitle) || normalizedTitle.startsWith(nt)) {
      return show;
    }
  }
  return null;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Image URL resolution
// ---------------------------------------------------------------------------

function resolveImageUrls(show) {
  const characters = show.characters.map((char) => {
    // No image (placeholder or empty) → null, content script shows silhouette
    if (!char.character_image || char.character_image_placeholder) {
      return { ...char, character_image_url: null };
    }
    // All images are stored as full GitHub raw URLs
    return { ...char, character_image_url: char.character_image };
  });
  return { ...show, characters };
}

// ---------------------------------------------------------------------------
// TMDB proxy
// ---------------------------------------------------------------------------

async function fetchFromTmdbProxy(title) {
  try {
    const url = `${VERCEL_URL}/api/tmdb-proxy?title=${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if (res.status === 429) {
      console.warn('[VoiceCast] TMDB proxy rate limited');
      return { found: false };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('[VoiceCast] TMDB proxy error:', err);
    return { found: false };
  }
}

// ---------------------------------------------------------------------------
// Missing show reporting
// ---------------------------------------------------------------------------

async function reportMissing(title) {
  try {
    const res = await fetch(`${VERCEL_URL}/api/report-missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok && res.status !== 429) {
      console.warn('[VoiceCast] report-missing failed:', res.status);
    }
    return { ok: true };
  } catch (err) {
    console.warn('[VoiceCast] report-missing error:', err);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

async function getCachedTmdb(normalizedTitle) {
  const key = `vc_tmdb_${normalizedTitle}`;
  const tsKey = `vc_tmdb_ts_${normalizedTitle}`;
  const [data, ts] = await Promise.all([storageGet(key), storageGet(tsKey)]);
  if (data && ts && Date.now() - ts < CACHE_TTL_MS) return data;
  return null;
}

async function setCachedTmdb(normalizedTitle, data) {
  const key = `vc_tmdb_${normalizedTitle}`;
  const tsKey = `vc_tmdb_ts_${normalizedTitle}`;
  await storageSet({ [key]: data, [tsKey]: Date.now() });
}

async function getCacheStats() {
  try {
    const all = await chrome.storage.local.get(null);
    const vcKeys = Object.keys(all).filter((k) => k.startsWith('vc_'));
    const layer2Ts = all['vc_layer2_ts'];
    return {
      totalKeys: vcKeys.length,
      layer2Age: layer2Ts ? Math.round((Date.now() - layer2Ts) / 3600000) : null,
      layer2ExpiresIn: layer2Ts
        ? Math.max(0, Math.round((CACHE_TTL_MS - (Date.now() - layer2Ts)) / 3600000))
        : null,
    };
  } catch (err) {
    console.warn('[VoiceCast] getCacheStats error:', err);
    return {};
  }
}

async function clearCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const vcKeys = Object.keys(all).filter((k) => k.startsWith('vc_'));
    await chrome.storage.local.remove(vcKeys);
    return { cleared: vcKeys.length };
  } catch (err) {
    console.warn('[VoiceCast] clearCache error:', err);
    return { cleared: 0 };
  }
}

// ---------------------------------------------------------------------------
// Storage wrappers
// ---------------------------------------------------------------------------

async function storageGet(key) {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key] ?? null));
  });
}

async function storageSet(obj) {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, resolve);
  });
}
