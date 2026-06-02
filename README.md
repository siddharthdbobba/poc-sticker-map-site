# POC Sticker Map

An interactive map of every place a **Purdue Outing Club** sticker has landed.
Built with **Astro** + **Leaflet** (`react-leaflet`), styled to match the club site
(gold on black/white) with a light/dark toggle. Data comes from a public Google Sheet.

🔗 Linked from my portfolio: [siddharthbobba.com](https://siddharthbobba.com)

## How it works

- A single React island (`StickerMapApp`, mounted `client:only="react"`) fetches the
  published Google Sheet **CSV** in the browser, parses it, and renders a Leaflet map
  with a marker per sighting. Click a marker for the photo + story.
- Basemap follows the theme (no API key): the **OpenStreetMap** standard street map in
  light, **CARTO Dark Matter** in dark — same OSM data. The surrounding UI follows the
  theme as well.
- The map read path is fully static. **Submissions** (the `/submit` page) use two
  Worker server routes (`/api/submit`, `/photos/[key]`) that need R2 + secrets — see
  [Submissions](#submissions-upload-page) below.

## Configuration

Copy `.env.example` → `.env` and set:

| Var | Purpose |
| --- | --- |
| `PUBLIC_STICKER_CSV_URL` | Published Google Sheet CSV (File → Share → Publish to web → CSV). Required — the map is empty without it. |
| `PUBLIC_GOOGLE_MAPS_EMBED_KEY` | Optional. Public key for inline Street View. Leave blank to disable the feature. See [Street View](#street-view-optional). |

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

## Street View (optional)

When a sticker point has Google Street View coverage, the lightbox gains a
**Photo | Street View** toggle that embeds the panorama inline (via the **Maps Embed
API** in `streetview` mode — free, unlimited, no per-load charge). Points with no
coverage show no Street View affordance, because a server route pre-checks Google's
free metadata endpoint first.

This needs **one Google Cloud project with billing enabled** (you are not charged for
Embed or metadata usage, but Google requires a card on file for the keys to work) and
**one runtime secret**. `/api/streetview` uses the key server-side for the free
coverage check and also returns it to the client for the embed iframe (the embed key
is public anyway), so the whole feature rides on a single **runtime secret** — no
build variable (those proved unreliable on connected-repo builds).

1. Create one Google Maps API key. Restrict it to the **Maps Embed API** + **Street
   View Static API**, and to HTTP referrers `stickers.siddharthbobba.com/*` and
   `localhost:8787/*`.
2. Set it as a runtime secret:
   ```sh
   wrangler secret put GOOGLE_STREETVIEW_KEY     # prod
   # local: GOOGLE_STREETVIEW_KEY=AIza… in .env
   ```

> Optional: to keep a strict split, set a separate public embed key as
> `GOOGLE_MAPS_EMBED_KEY` (the route returns it instead of reusing the metadata key).

Leave it unset and the map behaves exactly as before — no Street View UI.

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
