# VoiceCast technical playbook: safe scraping, resumable pipelines, and a lean MV3 data layer

**Switch from HTML scraping to the MediaWiki API and batch 50 pages per request — this alone should cut your ~47-hour run to well under an hour.** Every Fandom wiki exposes `api.php`; a single `generator=categorymembers` + `prop=revisions` call returns wikitext for 50 character pages at once. Pair that with Bottleneck (1 concurrent request per wiki, 3–5 globally, `minTime=1000ms`, `maxlag=5`), a content-addressable disk cache, and a SQLite checkpoint DB, and your pipeline becomes both dramatically faster and crash-safe. For the extension, ship gzipped per-show JSON as `web_accessible_resources` and lazy-load on demand — Chrome's 2 GB package limit and native `DecompressionStream` make this trivial. For the AI-assistant layer, Anthropic's Agent Skills spec (now an open standard as of Dec 2025) plus a handful of MCP servers (Chrome DevTools, GitHub, next-devtools, Playwright, MediaWiki) give you turnkey expertise per domain. One important caveat runs through everything: **Fandom's ToS explicitly prohibits scraping and AI-training use of their platform**, though individual wiki content is CC-BY-SA — a legal grey area you should resolve deliberately before scaling.

## Fandom scraping: use the API, batch hard, and stay polite

Every Fandom wiki exposes the full MediaWiki Action API at `https://{wiki}.fandom.com/api.php`. This is strictly faster, cleaner, and safer than HTML scraping — Fandom HTML pages are 1–3 MB with ads and tracking, while API JSON is compact and cache-friendly. The single most impactful pattern for VoiceCast is the **generator + prop=revisions combo**: one request returns wikitext for up to 50 character pages in a category, collapsing what would have been 50 HTTP round-trips into one.

```
action=query&generator=categorymembers&gcmtitle=Category:Characters
  &gcmlimit=50&prop=revisions&rvprop=content&rvslots=main
  &format=json&formatversion=2&maxlag=5
```

Use `continue` tokens to paginate. Include `format=json&formatversion=2` (cleaner output), **`maxlag=5`** (lets Fandom throttle you automatically under load — server returns an error with `Retry-After` when replica lag exceeds the threshold), and `Accept-Encoding: gzip`. Set a descriptive User-Agent following the Wikimedia pattern — `VoiceCastBot/1.0 (https://voicecast.app; contact@email) node-fetch/3`. Generic UAs (`python-requests`, empty strings, browser strings) can trigger Cloudflare 403s.

**Fandom publishes no hard numeric rate limit.** Community.fandom.com staff explicitly decline to give numbers; the closest official guidance is "more than one edit per second is too fast" (for writes; reads are more permissive). Third-party scraping vendors recommend "10 req/min" but that's marketing-conservative. MediaWiki's own etiquette guide says "no hard speed limit on read requests… making requests in series rather than in parallel… should result in a safe request rate." Synthesizing this for a safety-first 942-wiki crawl: **1 concurrent request per wiki, 3–5 globally across all subdomains, 500–1000 ms between requests on the same wiki**. Cloudflare rate-limits per-IP, so hitting 942 different subdomains doesn't let you escape aggregate limits. At these settings you'll process roughly 5 req/s globally; with 50-page batching, the full crawl is ~15k requests, or under an hour of wall time.

Retry on 429/503/5xx with exponential backoff and full jitter, honoring `Retry-After` headers when present. Do not retry 400/401/403/404. The fetch-with-retry pattern is straightforward:

```js
if (res.status === 429 || res.status === 503) {
  const retryAfter = Number(res.headers.get('Retry-After'));
  const wait = Number.isFinite(retryAfter)
    ? retryAfter * 1000
    : Math.min(60_000, 1000 * 2 ** attempt);
  await sleep(wait + Math.random() * 500); // full jitter
}
```

**Legal flag worth escalating:** Fandom's Terms of Use explicitly prohibit using "any robot, spider… to scrape, extract, retrieve or index any portion of the content" and specifically ban use "for the development of any software program, including…training a machine learning or artificial intelligence system." Per-wiki content is CC-BY-SA, which creates legitimate tension between the CC license's freedoms and Fandom's platform ToS. Database dumps exist at `Special:Statistics` but are unreliable, stale, and require admin action per wiki — not viable for 942 wikis. You should make a deliberate policy decision here; technically the API works fine, but this is not purely a technical question.

## The concurrency library that actually fits your workload

For controlled concurrency with rate-limit mirroring, **Bottleneck is the right pick** over p-limit/p-queue. Its `maxConcurrent` + `minTime` + `reservoir` (token bucket) combination is purpose-built for "respect an external API's rate limit," including per-host limiters composed with a global limiter. `p-limit` alone only caps concurrent promises — it has no inter-request timing. `p-queue` sits in the middle with `interval`+`intervalCap` and is a fine simpler alternative if you don't need reservoir/priority features. Wrap HTTP calls in **`p-retry`** (clean `AbortError` for permanent failures, full-jitter randomize, `onFailedAttempt` hook) or lean on **`got` v14**, which has built-in retry that respects `Retry-After` on 413/429/503 out of the box.

The composed pattern — a per-wiki Bottleneck (`{maxConcurrent: 1, minTime: 1000}`) chained inside a global Bottleneck (`{maxConcurrent: 5}`) — is the safety ceiling. `perWikiLimiter.schedule(...)` executes inside `globalLimiter.schedule(...)`, so both constraints apply.

## Make the 47-hour script resumable in one afternoon

The biggest quality-of-life upgrade for a long-running script is **`better-sqlite3` as a checkpoint store**. It's synchronous, faster than node-sqlite3 for single-process work, and WAL mode is atomic per-transaction. A single `jobs` table with `(id, status, attempts, last_error, finished_at, payload JSON)` replaces a brittle JSON checkpoint file. At startup, `SELECT id FROM jobs WHERE status IN ('pending','failed') AND attempts < 5` — that's your entire resume logic. Set `journal_mode=WAL`, `synchronous=NORMAL`, `mmap_size=268435456`. If you prefer JSON checkpoints anyway, use **`write-file-atomic`** (writes to `.tmp` then `rename()`, POSIX-atomic) — never plain `fs.writeFile`.

Caching belongs on disk. A **content-addressable cache** keyed by `sha256(url+params)` storing gzipped response bodies is the simplest correct design — files are inspectable, independent of HTTP cache semantics (Fandom headers aren't always useful), and make re-runs trivial. If you want something more off-the-shelf, **`axios-cache-interceptor`** handles ETag/If-None-Match/Vary automatically and includes in-flight request coalescing (concurrent identical GETs share one network call). **`cacheable-request` + `got` + `keyv` + `@keyv/sqlite`** is the canonical RFC-7234-compliant alternative. Use long TTLs for stable data (Fandom pages: 7–30 days; TMDB person/movie detail: 7–30 days), short TTLs for negatives (404s: 1h).

Stream output as **NDJSON** (`fs.createWriteStream('results.ndjson', {flags: 'a'})`, one JSON object per line, `\n`-delimited). Append-only, O(1) writes, survives hard kills (any complete line is valid), and trivially greppable. Run a separate compaction step at the end to build the final normalized database. **Never accumulate results in a single in-memory array** across a 47-hour run — even if 942 items fit today, the habit doesn't scale and complicates memory debugging.

For TMDB specifically, the old "40 requests per 10 seconds" limit was **disabled in December 2019**; current reality is roughly 40 req/s per IP with ~20 concurrent connections, enforced by CDN. Stay at 10–20 req/s for politeness. **`moviedb-promise`** (v4.x) is the current TypeScript client of choice with 100+ typed methods and a conservative built-in limiter. The single highest-leverage TMDB optimization is `append_to_response=movie_credits,tv_credits,external_ids,images` — collapses four requests per person into one.

Observability belongs on two separate channels: **`cli-progress`** on stdout for the human-facing bar (raise `etaBuffer` to 50–100 since each item takes ~3 min; default 10 produces wild ETAs), and **`pino`** (v9+) writing JSON to a logfile for structured inspection. Mixing them corrupts the bar redraw. Handle SIGINT/SIGTERM to flush NDJSON, close SQLite, and exit cleanly; with WAL + atomic writes + append-only output, even `kill -9` leaves a recoverable state.

Classify errors up front: transient (retry) vs permanent (don't). Retry `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`, and HTTP 408/429/500/502/503/504. Never retry 400/401/403/404 or JSON-parse errors on 200-responses. Append permanent failures to `dead-letter.ndjson` and mark `status='dead'` in SQLite — re-drive with a separate script when needed. Treat each show as a small transaction with `partial=true` flag handling so a failed voice-actor lookup doesn't discard 3 minutes of character work.

## The MV3 data layer: ship gzipped shards and fetch on demand

The Chrome Web Store 10 MB limit is obsolete; **current maximum package size is 2 GB zipped**. Your 10–50 MB of JSON compresses to 2–8 MB with gzip and is a non-issue. But `chrome.storage.local` is still a poor fit at this size — every read/write serializes the entire key value. The right answer for VoiceCast is a **hybrid of bundled files + IndexedDB + on-demand decompression**:

```
data/
  index.json           ~50–200 KB: [{id, title, aliases, year, characterCount}]
  shows/
    0001.json.gz       ~1–10 KB gzipped per show
    0002.json.gz
    ...
```

List these under `web_accessible_resources` in manifest.json, then `fetch(chrome.runtime.getURL('data/shows/0001.json.gz'))` from anywhere — popup, service worker, content script. Pipe through the native `DecompressionStream('gzip')` (baseline 2023 browser support, works in MV3 SWs, no external library needed):

```js
const stream = (await fetch(url)).body.pipeThrough(new DecompressionStream('gzip'));
const show = await new Response(stream).json();
```

This is preferable to bundling MessagePack/CBOR/Protobuf: `JSON.parse` is native and SIMD-optimized in V8 (~200–400 MB/s), and gzip-on-JSON typically beats MessagePack on the wire. One file per show is better than sharding by letter or ID range — 942 files is fine for the OS and Chrome, and per-file invalidation makes CDN updates cheap.

**Critical MV3 service worker constraints to design around:** 30-second idle timeout (each event resets it); no dynamic `import()` (disallowed in MV3 SWs — use `fetch(runtime.getURL(...))` instead); no `new Worker()` directly (spawn one from an **Offscreen Document** if you truly need it); in-memory state is ephemeral and must be re-hydrated on SW wake. Treat the SW as a function, not a daemon. A simple `Map<id, show>` cache is fine but must lazy-populate: if `cache.has(id)` return it, else fetch, decompress, cache, return.

For the index itself, use **Dexie.js** (IndexedDB wrapper, 25 KB gz, `bulkPut` is 5–10× faster than hand-rolled transactions) hydrated once on `chrome.runtime.onInstalled` with `reason === 'install' || 'update'`. Store the ~50–200 KB index there; the SW rebuilds an in-memory Map on wake by reading it back. For fuzzy search over character names, ship **MiniSearch** (7 KB gz, prefix + fuzzy + field boosts, persistent serialize/deserialize) — avoid sql.js/wa-sqlite at this scale; the complexity (OPFS + dedicated Worker + COOP/COEP + offscreen document) isn't justified for 942 records.

Request `"unlimitedStorage"` permission — no user-warning escalation and it removes all chrome.storage caps. For updates, a hybrid approach works best: bundle a snapshot for offline/first-install UX, then use `chrome.alarms` (24-hour period) to check `https://cdn.voicecast.app/manifest.json`, diff versions, and download only changed shards into the **Cache API**. Remote *data* is explicitly allowed by Chrome Web Store policy; remote *code execution* is forbidden — don't eval anything from the CDN.

## Wiring up an AI assistant that actually knows your stack

As of December 2025, Anthropic's **Agent Skills** are an open standard (spec at agentskills.io, reference SDK, adopted by VS Code/Copilot, Cursor, Codex CLI, Gemini CLI, Windsurf). A skill is a folder with a `SKILL.md` (YAML frontmatter + markdown + optional scripts); Claude loads metadata eagerly and bodies on demand via progressive disclosure. For VoiceCast you want **six project-level skills** committed to `.claude/skills/`:

| Skill | Codifies |
|---|---|
| `voicecast-fandom-scraper` | api.php query builder, Cloudflare fallback, rate-limit rules, UA convention, `continue` pagination |
| `voicecast-tmdb-enricher` | `append_to_response` patterns, ID matching via `/find/{external_id}`, image config caching |
| `voicecast-mv3-manifest` | manifest validation, CSP rules, `host_permissions` hygiene, submission checklist |
| `voicecast-json-db` | Zod schemas, migration pattern, MiniSearch index build, integrity audits |
| `voicecast-vercel-api` | edge-vs-node decision tree, CORS for `chrome-extension://<id>`, env-var scoping |
| `voicecast-actions-cron` | scheduled scraper workflow, secrets, artifacts, concurrency groups |

The MCP servers that actually earn their keep: **Chrome DevTools MCP** (official, `npx chrome-devtools-mcp@latest`) for live extension debugging with performance traces and console access; **GitHub's official MCP** at `api.githubcopilot.com/mcp/` for workflow runs, logs, artifacts, Dependabot; **`vercel/next-devtools-mcp`** for runtime diagnostics if your API layer is Next.js; **`@playwright/mcp`** (Microsoft) as a Cloudflare-bypass fallback when Fandom blocks raw fetch; and a MediaWiki MCP — prefer `olgasafonova/mediawiki-mcp-server` (Go, works with Fandom via api.php) over `ProfessionalWiki/MediaWiki-MCP-Server` which has an **open issue (#217) where Fandom's `/rest.php/v1` returns 403 from Cloudflare**.

For pre-built skill libraries, the highest-signal registries are **`VoltAgent/awesome-agent-skills`** (1,000+ vetted skills from real engineering teams — Anthropic, Vercel, Stripe, Cloudflare, Sentry) and **`obra/superpowers`** (TDD, `/brainstorm`, `/write-plan`, `/execute-plan`, debugging). Install `anthropics/skills` as a marketplace for `skill-creator`, `mcp-builder`, `testing-web-apps`. For security, add **`BehiSecc/vibesec`** (IDOR/XSS/SSRF prevention — relevant to your Vercel API and content scripts) and a `gitleaks` pre-commit hook. Skills can execute arbitrary code, so review any `SKILL.md` plus its scripts before installing, especially from bulk AI-generated marketplaces (tonsofskills, claudecodeplugins.io) — prefer vendor-maintained or named-engineer skills.

## Key takeaways and one important caveat

The five research threads converge on a clear architectural recipe. The **API-first, batched, politely-throttled scraper** (Bottleneck + p-retry + maxlag + content-addressable cache + better-sqlite3 checkpoints + NDJSON output) replaces your current 47-hour pipeline with something closer to an hour that's also crash-safe. The **MV3 extension ships gzipped per-show JSON as web_accessible_resources**, hydrates a lightweight index into Dexie on install, and uses MiniSearch for fuzzy search — avoiding the complexity trap of wa-sqlite/OPFS. The **AI assistant layer becomes project-specific** via six committed Agent Skills plus a handful of vendor-maintained MCP servers.

The single most important non-technical finding: **Fandom's Terms of Use prohibit scraping and explicitly ban AI training uses of their platform content**, even though individual wiki content is CC-BY-SA licensed. Every technical precaution in this report — polite rate limits, proper UAs, maxlag compliance — makes you a good citizen technically, but doesn't resolve the ToS question. Decide deliberately whether VoiceCast operates on the CC-BY-SA content basis (with proper attribution back to each wiki) or seeks affirmative permission from Fandom; either is defensible, but leaving it ambiguous is the one risk that engineering alone can't mitigate.