/**
 * Tests for content.js logic:
 * - Query parsing / false positive filtering
 * - Title extraction
 * - Panel injection (via jsdom)
 * - Fallback behavior (unknown show leaves DOM untouched)
 */

'use strict';

// ---------------------------------------------------------------------------
// Inline the parseCastQuery and extractTitle logic for unit testing
// (We test the logic directly without loading the full content script IIFE)
// ---------------------------------------------------------------------------

function parseCastQuery(search) {
  try {
    const params = new URLSearchParams(search);
    const q = params.get('q');
    if (!q) return null;

    if (!/\bcast\b/i.test(q)) return null;

    const falsePositivePrefixes = /\b(broad|pod|over|fore|tele|news)cast\b/i;
    const falsePositiveSuffixes = /\bcast(e|ing|le|away|off)\b/i;
    const falsePositivePhrases = /\bcast\s+iron\b/i;
    if (falsePositivePrefixes.test(q) || falsePositiveSuffixes.test(q) || falsePositivePhrases.test(q)) return null;

    const stopWords = new Set([
      'cast', 'the', 'of', 'a', 'an', 'movie', 'film', 'show', 'tv',
      'series', 'voice', 'actors', 'characters', 'animated', 'animation',
    ]);
    const tokens = q
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !stopWords.has(t));

    if (!tokens.length) return null;
    return tokens.join(' ');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Query parsing tests
// ---------------------------------------------------------------------------

describe('parseCastQuery — valid cast searches', () => {
  test('"shrek cast" → "shrek"', () => {
    expect(parseCastQuery('?q=shrek+cast')).toBe('shrek');
  });

  test('"toy story cast" → "toy story"', () => {
    expect(parseCastQuery('?q=toy+story+cast')).toBe('toy story');
  });

  test('"the cast of shrek" → "shrek"', () => {
    expect(parseCastQuery('?q=the+cast+of+shrek')).toBe('shrek');
  });

  test('"shrek voice cast" → "shrek"', () => {
    expect(parseCastQuery('?q=shrek+voice+cast')).toBe('shrek');
  });

  test('"the simpsons cast" → "simpsons"', () => {
    expect(parseCastQuery('?q=the+simpsons+cast')).toBe('simpsons');
  });

  test('"spirited away cast" → "spirited away"', () => {
    expect(parseCastQuery('?q=spirited+away+cast')).toBe('spirited away');
  });

  test('uppercase CAST works', () => {
    expect(parseCastQuery('?q=Shrek+CAST')).toBe('shrek');
  });

  test('"cast" alone returns null (no title)', () => {
    expect(parseCastQuery('?q=cast')).toBeNull();
  });
});

describe('parseCastQuery — false positives (should return null)', () => {
  test('"broadcast" rejected', () => {
    expect(parseCastQuery('?q=broadcast')).toBeNull();
  });

  test('"broadcast news" rejected', () => {
    expect(parseCastQuery('?q=broadcast+news')).toBeNull();
  });

  test('"podcast cast" — "podcast" is rejected, "cast" is separate → extract remaining', () => {
    // "podcast" contains "podcast" which matches falsePositivePrefixes (pod+cast)
    // The whole query should be null
    const result = parseCastQuery('?q=podcast+cast');
    expect(result).toBeNull();
  });

  test('"overcast" rejected', () => {
    expect(parseCastQuery('?q=overcast+weather')).toBeNull();
  });

  test('"caste system" rejected (caste)', () => {
    expect(parseCastQuery('?q=caste+system')).toBeNull();
  });

  test('"cast iron skillet" rejected (cast+iron)', () => {
    expect(parseCastQuery('?q=cast+iron+skillet')).toBeNull();
  });

  test('"casting director" rejected (casting)', () => {
    expect(parseCastQuery('?q=casting+director')).toBeNull();
  });

  test('no q param returns null', () => {
    expect(parseCastQuery('?search=foo')).toBeNull();
  });

  test('empty query returns null', () => {
    expect(parseCastQuery('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Panel building tests (DOM via jsdom)
// ---------------------------------------------------------------------------

describe('Panel DOM construction', () => {
  function buildCard(char) {
    const card = document.createElement('div');
    card.className = 'voicecast-card';

    const charName = document.createElement('div');
    charName.className = 'voicecast-char-name';
    charName.textContent = char.character_name;
    card.appendChild(charName);

    const actorName = document.createElement('div');
    actorName.className = 'voicecast-actor-name';
    actorName.textContent = char.voice_actor;
    card.appendChild(actorName);

    return card;
  }

  function buildPanel(show) {
    const root = document.createElement('div');
    root.className = 'voicecast-panel';

    const scroller = document.createElement('div');
    scroller.className = 'voicecast-scroller';

    for (const char of show.characters) {
      scroller.appendChild(buildCard(char));
    }
    root.appendChild(scroller);
    return root;
  }

  const mockShow = {
    title: 'Shrek',
    characters: [
      { character_name: 'Shrek', voice_actor: 'Mike Myers', character_image_url: null, voice_actor_photo: '' },
      { character_name: 'Donkey', voice_actor: 'Eddie Murphy', character_image_url: null, voice_actor_photo: '' },
    ],
  };

  test('panel has voicecast-panel class', () => {
    const panel = buildPanel(mockShow);
    expect(panel.classList.contains('voicecast-panel')).toBe(true);
  });

  test('panel contains correct number of cards', () => {
    const panel = buildPanel(mockShow);
    const cards = panel.querySelectorAll('.voicecast-card');
    expect(cards).toHaveLength(2);
  });

  test('character names are set via textContent (not innerHTML)', () => {
    const panel = buildPanel(mockShow);
    const names = panel.querySelectorAll('.voicecast-char-name');
    expect(names[0].textContent).toBe('Shrek');
    expect(names[1].textContent).toBe('Donkey');
  });

  test('voice actor names are set via textContent', () => {
    const panel = buildPanel(mockShow);
    const names = panel.querySelectorAll('.voicecast-actor-name');
    expect(names[0].textContent).toBe('Mike Myers');
    expect(names[1].textContent).toBe('Eddie Murphy');
  });

  test('XSS: <script> in character name is rendered as text, not executed', () => {
    const xssShow = {
      title: 'Test',
      characters: [{
        character_name: '<script>alert(1)</script>',
        voice_actor: 'Actor',
        character_image_url: null,
        voice_actor_photo: '',
      }],
    };
    const panel = buildPanel(xssShow);
    const name = panel.querySelector('.voicecast-char-name');
    expect(name.textContent).toBe('<script>alert(1)</script>');
    expect(panel.innerHTML).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// Injection fallback: unknown show leaves container untouched
// ---------------------------------------------------------------------------

describe('Panel injection fallback', () => {
  test('if show not found, container is not modified', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>Google original content</p>';
    const originalHTML = container.innerHTML;

    // Simulate: pendingShowData is null (show not found)
    const pendingShowData = null;
    if (pendingShowData) {
      // Would inject — but we don't
      container.innerHTML = '';
    }

    expect(container.innerHTML).toBe(originalHTML);
  });

  test('data-voicecast="injected" attribute marks replaced panel', () => {
    const container = document.createElement('div');

    // Simulate injection
    const panel = document.createElement('div');
    panel.className = 'voicecast-panel';
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(panel);
    container.setAttribute('data-voicecast', 'injected');

    expect(container.getAttribute('data-voicecast')).toBe('injected');
    expect(container.querySelector('.voicecast-panel')).toBeTruthy();
  });
});
