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
- No server / no secrets — it's a fully static site.

## Configuration

Copy `.env.example` → `.env` and set:

| Var | Purpose |
| --- | --- |
| `PUBLIC_STICKER_CSV_URL` | Published Google Sheet CSV (File → Share → Publish to web → CSV). Required — the map is empty without it. |
| `PUBLIC_STICKER_FORM_URL` | Google Form for the "Submit your sighting" button (optional). |

Sheet columns (row 1 headers): `name, latitude, longitude, date, description, photo_url, placed_by`.

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
