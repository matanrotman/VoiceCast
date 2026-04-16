# VoiceCast Database Schema

## Overview

The database is a JSON file with a top-level `shows` array. Each entry represents one animated show or movie. Character images are re-hosted in this repository under `data/images/` for stability.

---

## Root Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | integer | yes | Schema version number. Bump when making breaking changes. Current: `1`. |
| `updated_at` | string (ISO 8601) | yes | Timestamp of last modification. |
| `shows` | array | yes | Array of show entries (see below). |

---

## Show Entry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Canonical show/movie title, English. Used for search matching. |
| `tmdb_id` | integer | yes | TMDB numeric ID. Unique per `tmdb_type`. |
| `tmdb_type` | string | yes | `"movie"` or `"tv"`. Determines which TMDB endpoint to use. |
| `characters` | array | yes | Array of character entries (see below). |

---

## Character Entry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `character_name` | string | yes | Character's display name (no "(voice)" suffix). |
| `character_image` | string | yes | Relative path to re-hosted image, e.g. `data/images/shrek/shrek.png`. Extension resolves this to a `raw.githubusercontent.com` URL at runtime. Set to `""` when `character_image_placeholder` is `true`. |
| `character_image_placeholder` | boolean | yes | `true` when the character image could not be sourced. Extension shows a silhouette SVG placeholder instead. |
| `voice_actor` | string | yes | Voice actor's full display name. |
| `voice_actor_tmdb_id` | integer | yes | TMDB person ID for the voice actor. |
| `voice_actor_photo` | string | yes | TMDB image URL using `w200` size profile. Example: `https://image.tmdb.org/t/p/w200/{file_path}`. |

---

## Rules

1. **One entry per character**, not per actor. If an actor voices multiple characters in the same show, they get one `character` entry per character.
2. **No duplicate shows** by `tmdb_id` + `tmdb_type`. The scraper checks this before inserting.
3. **Layer 2 overrides Layer 1** at the show level (matched by `tmdb_id`). When the extension merges the two databases, the entire Layer 2 show entry replaces the Layer 1 entry if `tmdb_id` matches.
4. **Character names** must not include TMDB suffixes like "(voice)" — strip these when importing.
5. **Images** must be downloaded and resized to 200px width before committing. Do not hotlink external CDNs.

---

## Sample Entry (Shrek)

```json
{
  "title": "Shrek",
  "tmdb_id": 808,
  "tmdb_type": "movie",
  "characters": [
    {
      "character_name": "Shrek",
      "character_image": "data/images/shrek/shrek.png",
      "character_image_placeholder": false,
      "voice_actor": "Mike Myers",
      "voice_actor_tmdb_id": 7232,
      "voice_actor_photo": "https://image.tmdb.org/t/p/w200/sctMoOsVPAmgXOOlVCkZ0PrGSdp.jpg"
    },
    {
      "character_name": "Donkey",
      "character_image": "data/images/shrek/donkey.png",
      "character_image_placeholder": false,
      "voice_actor": "Eddie Murphy",
      "voice_actor_tmdb_id": 776,
      "voice_actor_photo": "https://image.tmdb.org/t/p/w200/ekZobS8isE6mA53RAiGDG93hBxL.jpg"
    },
    {
      "character_name": "Princess Fiona",
      "character_image": "data/images/shrek/fiona.png",
      "character_image_placeholder": false,
      "voice_actor": "Cameron Diaz",
      "voice_actor_tmdb_id": 6941,
      "voice_actor_photo": "https://image.tmdb.org/t/p/w200/if8gJsDJPmqHOOhMFZTgins6sR.jpg"
    }
  ]
}
```
