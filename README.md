# animex-api

THE DOCUMENTATION/README WAS MADE BY AN AI SO IT MIGHT NOT BE ACCURATE

## Setup

```bash
npm install
node index.js
```

Runs on port `5500` by default. Set a custom port with the `PORT` environment variable.

```bash
PORT=3000 node index.js
```

## Endpoints

### `GET /map/:anilistId`

Resolves an AniList ID to its AnimeX internal slug.

**Example**
```
GET /map/21
```
```json
{
  "anilistId": 21,
  "slug": "one-piece"
}
```

---

### `GET /episodes/:anilistId`

Returns the full episode list for an anime.

**Example**
```
GET /episodes/21
```
```json
{
  "total": 1000,
  "episodes": [
    {
      "id": "watch/ax/21/sub/1",
      "number": 1,
      "title": "I'm Luffy! The Man Who Will Become the Pirate King!",
      "filler": false
    }
  ]
}
```

---

### `GET /servers/:anilistId/:epNum`

Returns available sub and dub servers for a given episode.

**Example**
```
GET /servers/21/1
```
```json
{
  "sub": [{ "id": "uwu", "default": true }, { "id": "mochi" }],
  "dub": [{ "id": "kage" }]
}
```

---

### `GET /watch/:anilistId/:category/:epNum`

Fetches HLS streaming sources for an episode.

- `:category` — `sub` or `dub`
- `:epNum` — episode number
- `?server=` — (optional) preferred server ID (e.g. `uwu`, `mochi`, `kami`)

**Example**
```
GET /watch/21/sub/1
GET /watch/21/sub/1?server=uwu
```
```json
{
  "video_link": "https://...",
  "source_type": "hls",
  "available_qualities": ["1080p", "720p", "480p"],
  "sources": [
    { "url": "https://...", "file": "https://...", "quality": "1080p" }
  ],
  "tracks": [
    { "file": "https://...", "label": "English", "kind": "subtitles" }
  ],
  "selected_server_id": "uwu",
  "provider": "animex"
}
```

## Error Responses

All endpoints return a JSON error object with a `error` and `message` field on failure.

```json
{ "error": "no_sources", "message": "AnimeX has no slug for this title." }
{ "error": "no_episodes" }
{ "error": "not_found" }
```

## PM2 Deploy

```bash
pm2 start index.js --name "animex-api"
pm2 save
```
