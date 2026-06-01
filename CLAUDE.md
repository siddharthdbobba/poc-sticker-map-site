# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev            # Astro dev server at http://localhost:4321
npm run build          # astro build → dist/ — the closest thing to CI. Catches build-breaking
                       # errors (bad imports, syntax, module resolution). NOTE: it does NOT
                       # type-check; pure TS type errors pass the build. Use `npx astro check`
                       # (needs @astrojs/check) for real type-checking.
npm run preview        # build, then run the Worker locally via `wrangler dev` (exercises R2/KV/secrets)
npm run generate-types # `wrangler types` → regenerate worker-configuration.d.ts after editing bindings
npm run deploy         # build + `wrangler deploy` to the Worker (custom domain only)
```

There is **no test runner and no linter**. `npm run build` is the only automated verification — and it only catches *build-breaking* errors (bad imports, syntax, module resolution), **not** type errors (verified: a `const n: number = "string"` passes the build). For real type-checking, run `npx astro check` (requires adding `@astrojs/check`). Use `npm run preview` (not `npm run dev`) to test anything that touches the Worker routes, since `astro dev` does not bind R2/KV/secrets.

A project Stop hook (`.claude/settings.json`) auto-runs `npm run build` in the background after any turn that changed `src/`, `astro.config.mjs`, or `wrangler.jsonc`, and pings Claude only if the build breaks. Manage it via `/hooks`.

## Architecture

A hybrid Astro app on **Cloudflare Workers**. Most of the site is static-rendered, but two routes opt into SSR (`export const prerender = false`) because they need Worker bindings. Understanding the split between the static read path and the server write path is the key to this codebase.

**Read path (static, no secrets).** The map is a single React island — `StickerMapApp`, mounted `client:only="react"` in `src/pages/index.astro`. In the browser it fetches a **published Google Sheet CSV** (`PUBLIC_STICKER_CSV_URL`), parses it with the pure helper in `src/lib/stickers.ts`, and renders a Leaflet map (`react-leaflet`, OpenTopoMap basemap, no API key). Column headers in row 1 must match exactly: `name, latitude, longitude, date, description, photo_url, placed_by`. Rows with non-numeric lat/lng are silently dropped.

**Write path (SSR, needs bindings).** `/submit` (`src/pages/submit.astro` + `src/components/SubmitForm.tsx`) downscales the photo in-browser, geocodes a typed place via Nominatim, and POSTs multipart to `src/pages/api/submit.ts`. That route:
1. Validates fields and the photo by **magic bytes** (not the browser content-type). JPG/PNG/WebP/HEIC only; **SVG is deliberately rejected** as an XSS vector.
2. Stores the photo in **R2** (`PHOTOS` binding) under an unguessable `sightings/<uuid>.<ext>` key.
3. Appends a row to the **"Pending"** tab of the Google Sheet via an **Apps Script web app** (`apps-script/Code.gs`), authenticated with `SHEET_WEBHOOK_TOKEN`. Note: Apps Script returns HTTP 200 even when it rejects the token, so the route also checks the `ok` flag in the response body.

`src/pages/photos/[...key].ts` streams photos back out of R2.

**Approval is manual and out-of-band.** The map only ever reads the **Live** tab (gid=0). A submission lands in Pending; you approve it by moving the row Pending → Live in the sheet. There is no admin UI. Caveat: the raw `/photos/<uuid>` URL is reachable as soon as a photo is uploaded — review gates the *map*, not the photo URL. (Cloudflare Turnstile bot protection is a planned Phase 2.)

## Bindings & deploy (`wrangler.jsonc`)

- `PHOTOS` (R2 bucket `poc-sticker-photos`) — submission photos. Create once: `wrangler r2 bucket create poc-sticker-photos`.
- `SESSION` (KV) — required by the Astro Cloudflare adapter (sessions on by default). The namespace id is **pinned** in `wrangler.jsonc`; do not let a deploy re-create it (fails with KV error 10014).
- `ASSETS` — serves the static `dist/` output.
- Secrets: `SHEET_WEBHOOK_URL`, `SHEET_WEBHOOK_TOKEN` (`wrangler secret put …`). Locally, put them in `.env`.
- Deploy is locked to the custom domain `stickers.siddharthbobba.com`: `workers_dev: false`, `preview_urls: false`. The README's "deploy dist/ to any static host" note is stale — the submission routes require the Worker, so deploy with `npm run deploy`.

## Conventions

- Files carry a header comment explaining their role and the *why* behind security/edge-case decisions (see `src/pages/api/submit.ts`). Match that density when editing.
- `src/lib/stickers.ts` is intentionally pure — no `fetch`, no env access. Keep data-shaping logic there.
- Theme follows OS light/dark until the user explicitly toggles; the Leaflet basemap stays a fixed light topo style regardless of theme.
