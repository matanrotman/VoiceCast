/**
 * Tests for background.js logic:
 * - normalizeTitle
 * - findShow (exact and partial matching)
 * - Layer merge (Layer 2 overrides Layer 1 by tmdb_id)
 * - Cache hit/miss simulation
 * - Image URL resolution
 */

'use strict';

// ---------------------------------------------------------------------------
// Inline the pure functions from background.js for unit testing
// ---------------------------------------------------------------------------

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findShow(shows, normalizedTitle) {
  for (const show of shows) {
    if (normalizeTitle(show.title) === normalizedTitle) return show;
  }
  for (const show of shows) {
    const nt = normalizeTitle(show.title);
    if (nt.startsWith(normalizedTitle) || normalizedTitle.startsWith(nt)) {
      return show;
    }
  }
  return null;
}

function mergeShows(layer1, layer2) {
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

const GITHUB_RAW_ROOT = 'https://raw.githubusercontent.com/user/VoiceCast/main/';

function resolveImageUrls(show) {
  const characters = show.characters.map((char) => {
    if (char.character_image_placeholder || !char.character_image) {
      return { ...char, character_image_url: null };
    }
    return {
      ...char,
      character_image_url: GITHUB_RAW_ROOT + char.character_image,
    };
  });
  return { ...show, characters };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SHREK_L1 = {
  title: 'Shrek',
  tmdb_id: 808,
  tmdb_type: 'movie',
  characters: [
    {
      character_name: 'Shrek',
      character_image: 'data/images/shrek/shrek.png',
      character_image_placeholder: false,
      voice_actor: 'Mike Myers',
      voice_actor_tmdb_id: 7232,
      voice_actor_photo: 'https://image.tmdb.org/t/p/w200/abc.jpg',
    },
  ],
};

const SHREK_L2_UPDATED = {
  title: 'Shrek',
  tmdb_id: 808,
  tmdb_type: 'movie',
  characters: [
    {
      character_name: 'Shrek',
      character_image: 'data/images/shrek/shrek.png',
      character_image_placeholder: false,
      voice_actor: 'Mike Myers',
      voice_actor_tmdb_id: 7232,
      voice_actor_photo: 'https://image.tmdb.org/t/p/w200/updated.jpg',
    },
    {
      character_name: 'Donkey',
      character_image: 'data/images/shrek/donkey.png',
      character_image_placeholder: false,
      voice_actor: 'Eddie Murphy',
      voice_actor_tmdb_id: 776,
      voice_actor_photo: 'https://image.tmdb.org/t/p/w200/donkey.jpg',
    },
  ],
};

const TOY_STORY = {
  title: 'Toy Story',
  tmdb_id: 862,
  tmdb_type: 'movie',
  characters: [],
};

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe('normalizeTitle', () => {
  test('lowercases', () => expect(normalizeTitle('Shrek')).toBe('shrek'));
  test('strips punctuation', () => expect(normalizeTitle("Shrek's Adventure!")).toBe('shreks adventure'));
  test('collapses whitespace', () => expect(normalizeTitle('toy   story')).toBe('toy story'));
  test('trims edges', () => expect(normalizeTitle('  shrek  ')).toBe('shrek'));
  test('handles numbers', () => expect(normalizeTitle('Toy Story 3')).toBe('toy story 3'));
});

// ---------------------------------------------------------------------------
// findShow
// ---------------------------------------------------------------------------

describe('findShow', () => {
  const shows = [SHREK_L1, TOY_STORY];

  test('exact match — "shrek"', () => {
    expect(findShow(shows, 'shrek')).toBe(SHREK_L1);
  });

  test('exact match — "toy story"', () => {
    expect(findShow(shows, 'toy story')).toBe(TOY_STORY);
  });

  test('partial match — query is prefix of title', () => {
    expect(findShow(shows, 'toy')).toBe(TOY_STORY);
  });

  test('partial match — title is prefix of query', () => {
    expect(findShow(shows, 'shrek the movie')).toBe(SHREK_L1);
  });

  test('no match returns null', () => {
    expect(findShow(shows, 'spirited away')).toBeNull();
  });

  test('empty shows array returns null', () => {
    expect(findShow([], 'shrek')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer merge
// ---------------------------------------------------------------------------

describe('Layer merge', () => {
  test('Layer 2 overrides Layer 1 entry with same tmdb_id', () => {
    const layer1 = [SHREK_L1, TOY_STORY];
    const layer2 = [SHREK_L2_UPDATED];
    const merged = mergeShows(layer1, layer2);

    const shrek = merged.find((s) => s.tmdb_id === 808);
    expect(shrek.characters).toHaveLength(2); // Layer 2 has 2 chars
    expect(shrek.characters[0].voice_actor_photo).toContain('updated');
  });

  test('Layer 2 entry without Layer 1 counterpart is appended', () => {
    const layer1 = [SHREK_L1];
    const layer2 = [TOY_STORY];
    const merged = mergeShows(layer1, layer2);
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.tmdb_id === 862)).toBeTruthy();
  });

  test('Layer 1 entries not in Layer 2 are preserved', () => {
    const layer1 = [SHREK_L1, TOY_STORY];
    const layer2 = [];
    const merged = mergeShows(layer1, layer2);
    expect(merged).toHaveLength(2);
  });

  test('empty Layer 1 + Layer 2 returns Layer 2', () => {
    const merged = mergeShows([], [SHREK_L2_UPDATED]);
    expect(merged).toHaveLength(1);
    expect(merged[0].tmdb_id).toBe(808);
  });
});

// ---------------------------------------------------------------------------
// Image URL resolution
// ---------------------------------------------------------------------------

describe('resolveImageUrls', () => {
  test('character with image gets absolute GitHub raw URL', () => {
    const resolved = resolveImageUrls(SHREK_L1);
    expect(resolved.characters[0].character_image_url).toBe(
      'https://raw.githubusercontent.com/user/VoiceCast/main/data/images/shrek/shrek.png'
    );
  });

  test('character with placeholder flag gets null URL', () => {
    const show = {
      ...SHREK_L1,
      characters: [
        { ...SHREK_L1.characters[0], character_image_placeholder: true, character_image: '' },
      ],
    };
    const resolved = resolveImageUrls(show);
    expect(resolved.characters[0].character_image_url).toBeNull();
  });

  test('character with empty image gets null URL', () => {
    const show = {
      ...SHREK_L1,
      characters: [
        { ...SHREK_L1.characters[0], character_image: '', character_image_placeholder: false },
      ],
    };
    const resolved = resolveImageUrls(show);
    expect(resolved.characters[0].character_image_url).toBeNull();
  });

  test('original show object is not mutated', () => {
    resolveImageUrls(SHREK_L1);
    expect(SHREK_L1.characters[0].character_image_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cache — hit/miss simulation using chrome.storage mock
// ---------------------------------------------------------------------------

describe('Cache hit/miss', () => {
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => resolve(result[key] ?? null));
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  test('cache hit: fresh entry returns data without refetch', async () => {
    const key = 'vc_tmdb_shrek';
    const tsKey = 'vc_tmdb_ts_shrek';
    const data = { found: true, show: { title: 'Shrek' } };
    await storageSet({ [key]: data, [tsKey]: Date.now() });

    const cached = await storageGet(key);
    const ts = await storageGet(tsKey);
    const valid = cached && ts && (Date.now() - ts) < CACHE_TTL_MS;
    expect(valid).toBe(true);
    expect(cached.show.title).toBe('Shrek');
  });

  test('cache miss: no entry means null', async () => {
    const val = await storageGet('vc_tmdb_spirited_away');
    expect(val).toBeNull();
  });

  test('cache miss: expired entry treated as stale', async () => {
    const key = 'vc_tmdb_oldshow';
    const tsKey = 'vc_tmdb_ts_oldshow';
    const EIGHT_DAYS_AGO = Date.now() - (8 * 24 * 60 * 60 * 1000);
    await storageSet({ [key]: { found: true }, [tsKey]: EIGHT_DAYS_AGO });

    const ts = await storageGet(tsKey);
    const isExpired = (Date.now() - ts) >= CACHE_TTL_MS;
    expect(isExpired).toBe(true);
  });
});
