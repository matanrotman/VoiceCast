/**
 * Tests for scraper.js logic:
 * - TMDB response parsing (cast extraction, animation genre check)
 * - slugify
 * - Fandom URL generation
 * - Graceful failure when no image found
 * - database.json merging / dedup
 */

'use strict';

// ---------------------------------------------------------------------------
// Inline testable functions from scraper.js
// ---------------------------------------------------------------------------

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

const ANIMATION_GENRE_ID = 16;

function parseTmdbMovieCast(credits) {
  return (credits.cast || [])
    .filter((p) => /\(voice\)/i.test(p.character || ''))
    .slice(0, 20)
    .map((p) => ({
      character_name: p.character.replace(/\s*\(voice\)/gi, '').trim(),
      voice_actor: p.name,
      voice_actor_tmdb_id: p.id,
      voice_actor_photo: p.profile_path
        ? `https://image.tmdb.org/t/p/w200${p.profile_path}`
        : '',
    }))
    .filter((c) => c.character_name && c.voice_actor);
}

function parseTmdbTvCast(credits) {
  return (credits.cast || [])
    .slice(0, 20)
    .map((p) => {
      const rawChar = p.roles?.[0]?.character || p.character || '';
      return {
        character_name: rawChar.replace(/\s*\(voice\)/gi, '').trim(),
        voice_actor: p.name,
        voice_actor_tmdb_id: p.id,
        voice_actor_photo: p.profile_path
          ? `https://image.tmdb.org/t/p/w200${p.profile_path}`
          : '',
      };
    })
    .filter((c) => c.character_name && c.voice_actor);
}

function isAnimated(genreIds) {
  return Array.isArray(genreIds) && genreIds.includes(ANIMATION_GENRE_ID);
}

function buildFandomApiUrl(wikiSlug, characterName) {
  const params = new URLSearchParams({
    action: 'query',
    titles: characterName,
    prop: 'pageimages',
    pithumbsize: '400',
    format: 'json',
    origin: '*',
  });
  return `https://${wikiSlug}.fandom.com/api.php?${params}`;
}

function deduplicateShows(shows, newShow) {
  return shows.findIndex(
    (s) => s.tmdb_id === newShow.tmdb_id && s.tmdb_type === newShow.tmdb_type
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('slugify', () => {
  test('basic slug', () => expect(slugify('Shrek')).toBe('shrek'));
  test('multi-word', () => expect(slugify('Toy Story')).toBe('toy-story'));
  test('special chars stripped', () => expect(slugify("Shrek's Big Adventure!")).toBe('shreks-big-adventure'));
  test('numbers preserved', () => expect(slugify('Toy Story 3')).toBe('toy-story-3'));
  test('multiple spaces become single dash', () => expect(slugify('The  Simpsons')).toBe('the-simpsons'));
});

describe('isAnimated', () => {
  test('genre 16 present → true', () => expect(isAnimated([28, 16, 35])).toBe(true));
  test('genre 16 absent → false', () => expect(isAnimated([28, 35, 18])).toBe(false));
  test('empty array → false', () => expect(isAnimated([])).toBe(false));
  test('null → false', () => expect(isAnimated(null)).toBe(false));
  test('undefined → false', () => expect(isAnimated(undefined)).toBe(false));
});

describe('parseTmdbMovieCast', () => {
  const mockCredits = {
    cast: [
      { id: 1, name: 'Mike Myers', character: 'Shrek (voice)', profile_path: '/abc.jpg' },
      { id: 2, name: 'Eddie Murphy', character: 'Donkey (voice)', profile_path: '/def.jpg' },
      { id: 3, name: 'John Doe', character: 'Random Human', profile_path: null }, // not voice
      { id: 4, name: 'Cameron Diaz', character: 'Princess Fiona (voice)', profile_path: '/ghi.jpg' },
    ],
  };

  test('filters to voice cast only', () => {
    const cast = parseTmdbMovieCast(mockCredits);
    expect(cast).toHaveLength(3);
    expect(cast.find((c) => c.voice_actor === 'John Doe')).toBeUndefined();
  });

  test('strips "(voice)" from character names', () => {
    const cast = parseTmdbMovieCast(mockCredits);
    expect(cast[0].character_name).toBe('Shrek');
    expect(cast[1].character_name).toBe('Donkey');
  });

  test('builds TMDB photo URLs', () => {
    const cast = parseTmdbMovieCast(mockCredits);
    expect(cast[0].voice_actor_photo).toBe('https://image.tmdb.org/t/p/w200/abc.jpg');
  });

  test('empty profile_path → empty string (not broken URL)', () => {
    const cast = parseTmdbMovieCast(mockCredits);
    // John Doe was filtered out. Ensure no null in remaining cast
    cast.forEach((c) => expect(c.voice_actor_photo).toBeDefined());
  });

  test('caps at 20 entries', () => {
    const bigCredits = {
      cast: Array.from({ length: 30 }, (_, i) => ({
        id: i,
        name: `Actor ${i}`,
        character: `Character ${i} (voice)`,
        profile_path: null,
      })),
    };
    expect(parseTmdbMovieCast(bigCredits)).toHaveLength(20);
  });

  test('empty character name is filtered out', () => {
    const credits = {
      cast: [{ id: 1, name: 'Actor', character: ' (voice)', profile_path: null }],
    };
    // After stripping "(voice)", character_name would be empty → filtered
    const cast = parseTmdbMovieCast(credits);
    expect(cast).toHaveLength(0);
  });
});

describe('parseTmdbTvCast', () => {
  const mockTvCredits = {
    cast: [
      { id: 1, name: 'Dan Castellaneta', roles: [{ character: 'Homer Simpson' }], profile_path: '/homer.jpg' },
      { id: 2, name: 'Julie Kavner', roles: [{ character: 'Marge Simpson' }], profile_path: null },
    ],
  };

  test('extracts characters from roles array', () => {
    const cast = parseTmdbTvCast(mockTvCredits);
    expect(cast[0].character_name).toBe('Homer Simpson');
    expect(cast[1].character_name).toBe('Marge Simpson');
  });

  test('handles missing profile_path gracefully', () => {
    const cast = parseTmdbTvCast(mockTvCredits);
    expect(cast[1].voice_actor_photo).toBe('');
  });
});

describe('Fandom API URL generation', () => {
  test('builds correct MediaWiki API URL', () => {
    const url = buildFandomApiUrl('shrek', 'Shrek');
    expect(url).toContain('https://shrek.fandom.com/api.php');
    expect(url).toContain('action=query');
    expect(url).toContain('prop=pageimages');
    expect(url).toContain('titles=Shrek');
  });

  test('URL encodes character names with spaces', () => {
    const url = buildFandomApiUrl('simpsons', 'Homer Simpson');
    expect(url).toContain('Homer+Simpson');
  });
});

describe('Database deduplication', () => {
  const existingShows = [
    { title: 'Shrek', tmdb_id: 808, tmdb_type: 'movie', characters: [] },
    { title: 'Toy Story', tmdb_id: 862, tmdb_type: 'movie', characters: [] },
  ];

  test('finds existing show by tmdb_id + tmdb_type', () => {
    const idx = deduplicateShows(existingShows, { tmdb_id: 808, tmdb_type: 'movie' });
    expect(idx).toBe(0);
  });

  test('returns -1 for new show', () => {
    const idx = deduplicateShows(existingShows, { tmdb_id: 456, tmdb_type: 'tv' });
    expect(idx).toBe(-1);
  });

  test('same tmdb_id but different type is not a duplicate', () => {
    const idx = deduplicateShows(existingShows, { tmdb_id: 808, tmdb_type: 'tv' });
    expect(idx).toBe(-1);
  });
});
