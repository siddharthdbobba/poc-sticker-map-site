# POC Sticker Map

An interactive map of every place a **Purdue Outing Club** sticker has landed.
Built with **Astro** + **Leaflet** (`react-leaflet`), styled to match the club site
(gold on black/white) with a light/dark toggle. Data comes from a public Google Sheet.

🔗 Linked from my portfolio: [siddharthbobba.com](https://siddharthbobba.com)

## How it works

- A single React island (`StickerMapApp`, mounted `client:only="react"`) fetches the
  published Google Sheet **CSV** in the browser, parses it, and renders a Leaflet map
  with a marker per sighting. Click a marker for the photo + story.
- Terrain basemap is **OpenTopoMap** (no API key). The map imagery is a fixed light
  topographic style; the surrounding UI (chrome, drawer, skeleton) follows the theme.
- The map read path is fully static. **Submissions** (the `/submit` page) use two
  Worker server routes (`/api/submit`, `/photos/[key]`) that need R2 + secrets — see
  [Submissions](#submissions-upload-page) below.

## Configuration

Copy `.env.example` → `.env` and set:

| Var | Purpose |
| --- | --- |
| `PUBLIC_STICKER_CSV_URL` | Published Google Sheet CSV (File → Share → Publish to web → CSV). Required — the map is empty without it. |

Sheet columns (row 1 headers): `name, latitude, longitude, date, description, photo_url, placed_by`.

## Submissions (upload page)

`/submit` lets anyone contribute a sighting: it downscales the photo in-browser,
geocodes a typed place via Nominatim, and POSTs to `/api/submit`. That Worker route
stores the photo in **R2** and appends a row to the data tab via a small **Apps Script
web app** (`apps-script/Code.gs`) with `status = "pending"`. The map hides pending
rows — you approve a sighting by changing its **`status`** cell to `active`.

One-time setup:

1. **R2 bucket:** `wrangler r2 bucket create poc-sticker-photos`
   (binding `PHOTOS` is already in `wrangler.jsonc`).
2. **`status` column:** add a `status` header to the data tab so it reads
   `… | placed_by | status`. Leave existing rows blank (blank = active/visible).
3. **Apps Script:** follow the steps at the top of `apps-script/Code.gs` to deploy the
   web app and get its `/exec` URL.
4. **Secrets:**
   ```sh
   wrangler secret put SHEET_WEBHOOK_URL     # the Apps Script /exec URL
   wrangler secret put SHEET_WEBHOOK_TOKEN   # same value as TOKEN in Code.gs
   ```

> Note: review gates the **map**, not raw data. A pending row sits in the single
> published tab, so its text and `/photos/<uuid>` URL are publicly fetchable before
> approval — they're just filtered out of the map client-side.

Bot protection (Cloudflare Turnstile) is a planned Phase 2; until then manual review
is the guardrail.

## Develop

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static output → dist/
npm run preview    # serve the build
```

## Deploy

Static site — deploy `dist/` to any static host (Cloudflare Pages, Vercel, Netlify, …).
Set `PUBLIC_STICKER_CSV_URL` (and optionally `PUBLIC_STICKER_FORM_URL`) as build-time env
vars on the host. Update `site` in `astro.config.mjs` to the final URL.
