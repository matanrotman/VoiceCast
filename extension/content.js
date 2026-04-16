/**
 * VoiceCast content script.
 *
 * Runs on google.com/search pages. Detects cast queries for animated shows,
 * waits for Google's cast panel to appear via MutationObserver, then replaces
 * it with our custom VoiceCast panel.
 *
 * Critical rules:
 * - Never use innerHTML with unsanitized strings — use createElement + textContent
 * - Never make fetch calls — all network goes through background.js
 * - Wrap ALL DOM queries in try/catch — Google's DOM structure is not stable
 * - Use MutationObserver (not DOMContentLoaded) — Google is a SPA
 */

(function () {
  'use strict';

  // State
  let currentQuery = null;
  let pendingShowData = null;
  let injected = false;
  let observer = null;
  let lastHref = window.location.href;
  let debounceTimer = null;

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  function init() {
    const query = parseCastQuery();
    if (!query) return; // not a cast search — do nothing

    currentQuery = query;
    pendingShowData = null;
    injected = false;

    // Kick off background lookup (async — result arrives via callback)
    requestShowData(query);

    // Watch for Google's cast panel to appear
    startObserver();
  }

  // ---------------------------------------------------------------------------
  // Query parsing
  // ---------------------------------------------------------------------------

  function parseCastQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('q');
      if (!q) return null;

      // Require "cast" as a standalone word
      if (!/\bcast\b/i.test(q)) return null;

      // Filter false positives containing "cast" as a substring of another word
      const falsePositivePrefixes = /\b(broad|pod|over|fore|tele|news)cast\b/i;
      const falsePositiveSuffixes = /\bcast(e|ing|le|away|off)\b/i;
      const falsePositivePhrases = /\bcast\s+iron\b/i;
      if (falsePositivePrefixes.test(q) || falsePositiveSuffixes.test(q) || falsePositivePhrases.test(q)) return null;

      // Extract title: remove "cast" and common stop words
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
    } catch (err) {
      console.warn('[VoiceCast] parseCastQuery error:', err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Background communication
  // ---------------------------------------------------------------------------

  function requestShowData(title) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime) return;

      chrome.runtime.sendMessage({ action: 'LOOKUP_SHOW', title }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[VoiceCast] sendMessage error:', chrome.runtime.lastError.message);
          return;
        }
        handleShowData(response);
      });
    } catch (err) {
      console.warn('[VoiceCast] requestShowData error:', err);
    }
  }

  function handleShowData(data) {
    if (!data || !data.found || !data.show) {
      // Nothing to do — leave Google's panel alone
      pendingShowData = null;
      return;
    }

    pendingShowData = data.show;

    // If the observer already found the Google panel, inject now
    tryInject();
  }

  // ---------------------------------------------------------------------------
  // MutationObserver — wait for Google's cast panel
  // ---------------------------------------------------------------------------

  function startObserver() {
    stopObserver();
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function onMutation() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(tryInject, 150);
  }

  // ---------------------------------------------------------------------------
  // Injection logic
  // ---------------------------------------------------------------------------

  function tryInject() {
    if (injected) return;
    if (!pendingShowData) return; // data not ready yet

    const panelContainer = findGoogleCastPanel();
    if (!panelContainer) return; // panel not rendered yet

    stopObserver(); // disconnect BEFORE mutating DOM

    try {
      injectPanel(panelContainer, pendingShowData);
      injected = true;
      panelContainer.setAttribute('data-voicecast', 'injected');
    } catch (err) {
      console.warn('[VoiceCast] injectPanel error:', err);
      startObserver(); // reconnect on failure
    }
  }

  // ---------------------------------------------------------------------------
  // Google cast panel detection — multiple fallback strategies
  // ---------------------------------------------------------------------------

  function findGoogleCastPanel() {
    // Strategy 1: data-attrid attribute containing "cast"
    try {
      const el = document.querySelector('[data-attrid*="cast"]');
      if (el && !el.getAttribute('data-voicecast')) return el;
    } catch (_) {}

    // Strategy 2: heading whose text is exactly "Cast" near a scroller
    try {
      const headings = document.querySelectorAll('h3, h4, [role="heading"]');
      for (const h of headings) {
        if (h.textContent.trim() === 'Cast') {
          const panel = h.closest('[data-attrid], .knowledge-panel, .kp-blk') ||
                        h.parentElement?.parentElement;
          if (panel && !panel.getAttribute('data-voicecast')) return panel;
        }
      }
    } catch (_) {}

    // Strategy 3: g-scrolling-carousel with person cards (Google's typical cast layout)
    try {
      const carousels = document.querySelectorAll('g-scrolling-carousel');
      for (const carousel of carousels) {
        const imgs = carousel.querySelectorAll('img');
        const names = carousel.querySelectorAll('[data-hveid], .Z4Cazf, .Jjl5z');
        if (imgs.length >= 2 && names.length >= 2) {
          const container = carousel.closest('[data-attrid], .kp-blk') || carousel.parentElement;
          if (container && !container.getAttribute('data-voicecast')) return container;
        }
      }
    } catch (_) {}

    // Strategy 4: any element with known cast-related data attributes
    try {
      const selectors = [
        '[data-attrid="kc:/film/film:cast"]',
        '[data-attrid="kc:/tv/tv_program:regular_cast"]',
        '[jsname] g-scrolling-carousel',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && !el.getAttribute('data-voicecast')) {
          return el.closest('[data-attrid]') || el.parentElement || el;
        }
      }
    } catch (_) {}

    return null;
  }

  // ---------------------------------------------------------------------------
  // Panel DOM construction — createElement only, never innerHTML
  // ---------------------------------------------------------------------------

  function injectPanel(container, show) {
    // Build our panel
    const panel = buildPanel(show);

    // Replace the content of Google's container
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    container.appendChild(panel);
  }

  function buildPanel(show) {
    const root = document.createElement('div');
    root.className = 'voicecast-panel';

    // Header row
    const header = document.createElement('div');
    header.className = 'voicecast-header';

    const title = document.createElement('span');
    title.className = 'voicecast-title';
    title.textContent = 'Cast';
    header.appendChild(title);

    const badge = document.createElement('span');
    badge.className = 'voicecast-badge';
    badge.textContent = 'VoiceCast';
    header.appendChild(badge);

    root.appendChild(header);

    // Scrollable card row
    const scroller = document.createElement('div');
    scroller.className = 'voicecast-scroller';

    for (const char of show.characters) {
      scroller.appendChild(buildCard(char));
    }

    root.appendChild(scroller);
    return root;
  }

  function buildCard(char) {
    const card = document.createElement('div');
    card.className = 'voicecast-card';

    // Character image
    const charImgWrapper = document.createElement('div');
    charImgWrapper.className = 'voicecast-char-img-wrapper';

    if (char.character_image_url) {
      const charImg = document.createElement('img');
      charImg.className = 'voicecast-char-img';
      charImg.alt = char.character_name;
      charImg.loading = 'lazy';
      charImg.onerror = function () {
        this.style.display = 'none';
        charImgWrapper.appendChild(buildSilhouette());
      };
      charImg.src = char.character_image_url;
      charImgWrapper.appendChild(charImg);
    } else {
      charImgWrapper.appendChild(buildSilhouette());
    }

    card.appendChild(charImgWrapper);

    // Character name
    const charName = document.createElement('div');
    charName.className = 'voicecast-char-name';
    charName.textContent = char.character_name;
    card.appendChild(charName);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'voicecast-divider';
    card.appendChild(divider);

    // Voice actor photo
    const actorImgWrapper = document.createElement('div');
    actorImgWrapper.className = 'voicecast-actor-img-wrapper';

    if (char.voice_actor_photo) {
      const actorImg = document.createElement('img');
      actorImg.className = 'voicecast-actor-img';
      actorImg.alt = char.voice_actor;
      actorImg.loading = 'lazy';
      actorImg.onerror = function () {
        this.style.display = 'none';
      };
      actorImg.src = char.voice_actor_photo;
      actorImgWrapper.appendChild(actorImg);
    }

    card.appendChild(actorImgWrapper);

    // Voice actor name
    const actorName = document.createElement('div');
    actorName.className = 'voicecast-actor-name';
    actorName.textContent = char.voice_actor;
    card.appendChild(actorName);

    return card;
  }

  function buildSilhouette() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'voicecast-silhouette');
    svg.setAttribute('aria-hidden', 'true');

    // Body silhouette shape
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100');
    bg.setAttribute('height', '100');
    bg.setAttribute('fill', 'var(--vc-placeholder-bg, #e8e8e8)');
    svg.appendChild(bg);

    // Head
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    head.setAttribute('cx', '50');
    head.setAttribute('cy', '35');
    head.setAttribute('r', '18');
    head.setAttribute('fill', 'var(--vc-placeholder-fg, #b0b0b0)');
    svg.appendChild(head);

    // Body
    const body = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    body.setAttribute('cx', '50');
    body.setAttribute('cy', '80');
    body.setAttribute('rx', '28');
    body.setAttribute('ry', '24');
    body.setAttribute('fill', 'var(--vc-placeholder-fg, #b0b0b0)');
    svg.appendChild(body);

    return svg;
  }

  // ---------------------------------------------------------------------------
  // SPA navigation — detect URL changes and re-run
  // ---------------------------------------------------------------------------

  function watchForNavigation() {
    // Use the Navigation API if available (Chrome 102+)
    if (typeof navigation !== 'undefined' && navigation.addEventListener) {
      navigation.addEventListener('navigate', () => {
        setTimeout(onNavigate, 100);
      });
      return;
    }

    // Fallback: poll href every 500ms
    setInterval(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        onNavigate();
      }
    }, 500);
  }

  function onNavigate() {
    stopObserver();
    clearTimeout(debounceTimer);

    // Reset state
    currentQuery = null;
    pendingShowData = null;
    injected = false;

    // Re-run detection for the new URL
    init();
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  try {
    init();
    watchForNavigation();
  } catch (err) {
    console.warn('[VoiceCast] Bootstrap error:', err);
  }
})();
