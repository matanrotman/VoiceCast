/**
 * VoiceCast Vercel serverless function: TMDB proxy
 *
 * GET /api/tmdb-proxy?title=shrek
 *
 * Searches TMDB for the given title, confirms it's animated (genre 16),
 * and returns cast data. The TMDB API key lives only in Vercel env vars —
 * users never see or configure it.
 *
 * Rate limited: 30 requests/minute per IP via Upstash Redis.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ---------------------------------------------------------------------------
// Rate limiter (initialized lazily to avoid cold-start penalty on import)
// ---------------------------------------------------------------------------

let ratelimit = null;

function getRatelimit() {
  if (!ratelimit) {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'vc_tmdb',
    });
  }
  return ratelimit;
}

// ---------------------------------------------------------------------------
// TMDB helpers
// ---------------------------------------------------------------------------

const TMDB_BASE = 'https://api.themoviedb.org/3';
const ANIMATION_GENRE_ID = 16;

function tmdbFetch(path) {
  const url = `${TMDB_BASE}${path}`;
  const apiKey = process.env.TMDB_API_KEY;
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${url}${sep}api_key=${apiKey}&language=en-US`);
}

async function searchTitle(title) {
  // Search both movie and TV, pick the best animated result
  const [movieRes, tvRes] = await Promise.all([
    tmdbFetch(`/search/movie?query=${encodeURIComponent(title)}`),
    tmdbFetch(`/search/tv?query=${encodeURIComponent(title)}`),
  ]);

  const [movieData, tvData] = await Promise.all([
    movieRes.ok ? movieRes.json() : { results: [] },
    tvRes.ok ? tvRes.json() : { results: [] },
  ]);

  // Filter to animated results only (genre 16)
  const animatedMovies = (movieData.results || []).filter(
    (r) => r.genre_ids && r.genre_ids.includes(ANIMATION_GENRE_ID)
  );
  const animatedTv = (tvData.results || []).filter(
    (r) => r.genre_ids && r.genre_ids.includes(ANIMATION_GENRE_ID)
  );

  // Prefer the top animated result; movies first, then TV
  if (animatedMovies.length > 0) {
    return { result: animatedMovies[0], type: 'movie' };
  }
  if (animatedTv.length > 0) {
    return { result: animatedTv[0], type: 'tv' };
  }

  // If no animated results, check if any result exists (to distinguish "not animated" vs "not found")
  const allMovies = movieData.results || [];
  const allTv = tvData.results || [];
  if (allMovies.length > 0 || allTv.length > 0) {
    return { result: null, type: null, notAnimated: true };
  }

  return { result: null, type: null };
}

async function fetchCredits(tmdbId, type) {
  const path = type === 'movie'
    ? `/movie/${tmdbId}/credits`
    : `/tv/${tmdbId}/aggregate_credits`;

  const res = await tmdbFetch(path);
  if (!res.ok) throw new Error(`TMDB credits HTTP ${res.status}`);
  const data = await res.json();

  // TV uses aggregate_credits which has a different shape
  const cast = type === 'tv' ? (data.cast || []) : (data.cast || []);

  return cast
    .filter((person) => {
      // For movies: filter to voice cast (character name contains "(voice)")
      // For TV: all cast are series regulars, include all
      if (type === 'movie') {
        return person.character && /\(voice\)/i.test(person.character);
      }
      return true;
    })
    .slice(0, 20) // cap at 20 characters
    .map((person) => {
      // TV aggregate_credits has roles array; movie credits has character string
      const characterName = type === 'tv'
        ? (person.roles && person.roles[0] && person.roles[0].character) || person.character || ''
        : person.character || '';

      // Strip "(voice)" suffix from character name
      const cleanName = characterName.replace(/\s*\(voice\)/gi, '').trim();

      const photoPath = person.profile_path;

      return {
        character_name: cleanName,
        character_image: '',
        character_image_placeholder: true,
        voice_actor: person.name || '',
        voice_actor_tmdb_id: person.id,
        voice_actor_photo: photoPath
          ? `https://image.tmdb.org/t/p/w200${photoPath}`
          : '',
      };
    })
    .filter((c) => c.character_name && c.voice_actor); // drop empty entries
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Input validation
  const { title } = req.query;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title parameter is required' });
  }
  const sanitizedTitle = title.replace(/<[^>]*>/g, '').trim().slice(0, 200);
  if (!sanitizedTitle) {
    return res.status(400).json({ error: 'title must not be empty' });
  }

  // Rate limiting
  try {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';
    const { success } = await getRatelimit().limit(ip);
    if (!success) {
      return res.status(429).json({ error: 'Rate limited. Try again later.' });
    }
  } catch (err) {
    // If Upstash is unavailable, fail open (don't block the request)
    console.error('[VoiceCast tmdb-proxy] Rate limit check failed:', err.message);
  }

  // TMDB lookup
  try {
    const { result, type, notAnimated } = await searchTitle(sanitizedTitle);

    if (notAnimated) {
      return res.status(200).json({ found: true, is_animated: false });
    }

    if (!result) {
      return res.status(200).json({ found: false });
    }

    const characters = await fetchCredits(result.id, type);

    const responseTitle = type === 'movie'
      ? result.title || result.original_title
      : result.name || result.original_name;

    return res.status(200).json({
      found: true,
      is_animated: true,
      tmdb_id: result.id,
      tmdb_type: type,
      title: responseTitle,
      show: {
        title: responseTitle,
        tmdb_id: result.id,
        tmdb_type: type,
        characters,
      },
    });
  } catch (err) {
    console.error('[VoiceCast tmdb-proxy] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
