/**
 * VoiceCast Vercel serverless function: report a missing animated show
 *
 * POST /api/report-missing
 * Body: { "title": "Spirited Away" }
 *
 * Opens a GitHub Issue labeled "missing-show" so the daily scraper can
 * add the show to the database. Deduplicates by checking open issues first.
 * Rate limited: 10 requests/minute per IP via Upstash Redis.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ---------------------------------------------------------------------------
// Rate limiter
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
      limiter: Ratelimit.slidingWindow(10, '1 m'),
      prefix: 'vc_report',
    });
  }
  return ratelimit;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

function githubFetch(path, options = {}) {
  const repo = process.env.GITHUB_REPO; // e.g. "username/VoiceCast"
  const token = process.env.GITHUB_PAT;
  return fetch(`${GITHUB_API}/repos/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

function normalizeForDedup(title) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

async function checkDuplicate(title) {
  const normalized = normalizeForDedup(title);
  // Search open issues with the missing-show label
  const res = await githubFetch(
    `/issues?labels=missing-show&state=open&per_page=100`
  );
  if (!res.ok) {
    // If we can't check for duplicates, allow the issue to be created
    // (better a duplicate than blocking a legitimate report)
    return false;
  }
  const issues = await res.json();
  return issues.some((issue) => {
    const issueNorm = normalizeForDedup(issue.title.replace('[Missing Show]', ''));
    return issueNorm === normalized;
  });
}

async function createIssue(title) {
  const now = new Date().toISOString();
  const body = `**Requested animated show:** ${title}\n\n**Reported at:** ${now}\n\n---\n*Automatically reported by VoiceCast extension. The daily scraper will process this issue.*`;

  const res = await githubFetch('/issues', {
    method: 'POST',
    body: JSON.stringify({
      title: `[Missing Show] ${title}`,
      body,
      labels: ['missing-show'],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Input sanitization
// ---------------------------------------------------------------------------

function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  // Strip HTML tags and common injection attempts
  let s = raw.replace(/<[^>]*>/g, '');
  // Remove URLs
  s = s.replace(/https?:\/\/\S+/gi, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Max length
  s = s.slice(0, 200);
  return s || null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const title = sanitizeTitle(body?.title);
  if (!title) {
    return res.status(400).json({ error: 'title is required and must not be empty' });
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
    console.error('[VoiceCast report-missing] Rate limit check failed:', err.message);
  }

  // Dedup check + create issue
  try {
    const isDuplicate = await checkDuplicate(title);
    if (isDuplicate) {
      return res.status(200).json({ status: 'duplicate' });
    }

    await createIssue(title);
    return res.status(200).json({ status: 'reported' });
  } catch (err) {
    console.error('[VoiceCast report-missing] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
