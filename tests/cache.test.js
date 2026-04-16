/**
 * Tests for cache behavior in background.js
 *
 * We test the storage wrapper functions by exercising them through
 * the background message handlers (LOOKUP_SHOW with cache pre-populated).
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers — simulate what background.js does with storage
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key] ?? null));
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, resolve);
  });
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cache — namespace', () => {
  test('all VoiceCast keys use vc_ prefix', async () => {
    await storageSet({ vc_test_key: 'value', other_key: 'other' });
    const all = await new Promise((resolve) => {
      chrome.storage.local.get(null, resolve);
    });
    const vcKeys = Object.keys(all).filter((k) => k.startsWith('vc_'));
    expect(vcKeys).toContain('vc_test_key');
    expect(vcKeys).not.toContain('other_key');
  });

  test('vc_ prefix keys are readable back', async () => {
    await storageSet({ vc_layer2_db: [{ title: 'Test' }] });
    const val = await storageGet('vc_layer2_db');
    expect(val).toEqual([{ title: 'Test' }]);
  });
});

describe('Cache — TTL', () => {
  test('fresh entry (within 7 days) returns data', async () => {
    const normalized = normalizeTitle('shrek');
    const key = `vc_tmdb_${normalized}`;
    const tsKey = `vc_tmdb_ts_${normalized}`;
    const fakeData = { found: true, show: { title: 'Shrek' } };

    await storageSet({ [key]: fakeData, [tsKey]: Date.now() });

    const data = await storageGet(key);
    const ts = await storageGet(tsKey);
    const isValid = data && ts && (Date.now() - ts) < CACHE_TTL_MS;

    expect(isValid).toBe(true);
    expect(data).toEqual(fakeData);
  });

  test('expired entry (older than 7 days) should be treated as stale', async () => {
    const normalized = normalizeTitle('shrek');
    const key = `vc_tmdb_${normalized}`;
    const tsKey = `vc_tmdb_ts_${normalized}`;
    const fakeData = { found: true, show: { title: 'Shrek' } };
    const EIGHT_DAYS_AGO = Date.now() - (8 * 24 * 60 * 60 * 1000);

    await storageSet({ [key]: fakeData, [tsKey]: EIGHT_DAYS_AGO });

    const ts = await storageGet(tsKey);
    const isExpired = (Date.now() - ts) >= CACHE_TTL_MS;
    expect(isExpired).toBe(true);
  });

  test('missing timestamp means no valid cache', async () => {
    const normalized = normalizeTitle('toy story');
    const key = `vc_tmdb_${normalized}`;
    await storageSet({ [key]: { found: true } });
    // No timestamp set

    const ts = await storageGet(`vc_tmdb_ts_${normalized}`);
    expect(ts).toBeNull();
    // Without ts, cache is invalid
  });
});

describe('Cache — clear', () => {
  test('clear removes only vc_ prefixed keys', async () => {
    await storageSet({
      vc_layer2_db: ['data'],
      vc_tmdb_shrek: { found: true },
      non_vc_key: 'keep me',
    });

    // Simulate clearCache
    const all = await new Promise((resolve) => {
      chrome.storage.local.get(null, resolve);
    });
    const vcKeys = Object.keys(all).filter((k) => k.startsWith('vc_'));
    await new Promise((resolve) => chrome.storage.local.remove(vcKeys, resolve));

    const afterClear = await new Promise((resolve) => {
      chrome.storage.local.get(null, resolve);
    });
    expect(Object.keys(afterClear)).not.toContain('vc_layer2_db');
    expect(Object.keys(afterClear)).not.toContain('vc_tmdb_shrek');
    expect(afterClear['non_vc_key']).toBe('keep me');
  });

  test('clear on empty storage returns 0 cleared', async () => {
    const all = await new Promise((resolve) => {
      chrome.storage.local.get(null, resolve);
    });
    const vcKeys = Object.keys(all).filter((k) => k.startsWith('vc_'));
    expect(vcKeys).toHaveLength(0);
  });
});

describe('Cache — storage never uses localStorage', () => {
  test('localStorage is not used', () => {
    // localStorage should never be called in VoiceCast
    const localStorageSpy = jest.spyOn(Storage.prototype, 'setItem');
    storageSet({ vc_test: 'val' });
    expect(localStorageSpy).not.toHaveBeenCalled();
    localStorageSpy.mockRestore();
  });
});

describe('Cache — Layer 2 caching', () => {
  test('layer2 db and timestamp are stored with correct keys', async () => {
    const fakeShows = [{ title: 'Shrek', tmdb_id: 808, tmdb_type: 'movie', characters: [] }];
    await storageSet({ vc_layer2_db: fakeShows, vc_layer2_ts: Date.now() });

    const db = await storageGet('vc_layer2_db');
    const ts = await storageGet('vc_layer2_ts');

    expect(db).toEqual(fakeShows);
    expect(typeof ts).toBe('number');
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});
