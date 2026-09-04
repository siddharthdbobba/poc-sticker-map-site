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
npm run check          # `astro check` → REAL type-checking (npm run build does not type-check)
npm run generate-types # `wrangler types` → regenerate worker-configuration.d.ts after editing bindings
npm run deploy         # build + `wrangler deploy` to the Worker (custom domain only)
```

There is **no test runner and no linter**, but `npm run check` (`astro check`, with `typescript` + `@astrojs/check` as devDependencies) now does real type-checking — note it needs TypeScript **6.x**, since TS 7 dropped the programmatic API the checker uses. `npm run build` is the only automated verification — and it only catches *build-breaking* errors (bad imports, syntax, module resolution), **not** type errors (verified: a `const n: number = "string"` passes the build). For real type-checking, run `npx astro check` (requires adding `@astrojs/check`). Use `npm run preview` (not `npm run dev`) to test anything that touches the Worker routes, since `astro dev` does not bind R2/KV/secrets.

A project Stop hook (`.claude/settings.json`) runs `npm run build` in the background after any turn that left `src/`, `astro.config.mjs`, or `wrangler.jsonc` dirty, and **notifies you** (macOS notification + a system message) only if the build breaks — it never auto-edits. Manage or disable it via `/hooks`.

## Architecture

A hybrid Astro app on **Cloudflare Workers**. Most of the site is static-rendered, but three routes opt into SSR (`export const prerender = false`) because they need Worker bindings/secrets. Understanding the split between the static read path and the server write path is the key to this codebase.

**Read path (static, no secrets).** The map is a single React island — `StickerMapApp`, mounted `client:only="react"` in `src/pages/index.astro`. In the browser it fetches a **published Google Sheet CSV** (`PUBLIC_STICKER_CSV_URL`), parses it with the pure helper in `src/lib/stickers.ts`, and renders a Leaflet map (`react-leaflet`, OpenStreetMap standard street basemap, no API key). Column headers in row 1 must match exactly: `name, latitude, longitude, date, description, photo_url, placed_by, status`. Rows with non-numeric lat/lng are silently dropped, as are rows whose `status` is `"pending"`.

**Street View (optional, read path).** Clicking a marker opens a drawer; if the point has Google Street View coverage, a button opens an inline panorama in the lightbox (`LocationModal`), using the **Maps Embed API in `streetview` mode** (free, unlimited, no per-load charge). `src/components/StickerMapApp.tsx` calls `src/pages/api/streetview.ts` on each marker select — an SSR route that does the coverage pre-check against Google's free metadata endpoint **server-side** (it isn't CORS-friendly) and returns `{ available, embedKey }`. Crucially, the **embed key is delivered at runtime in that response, not via a build-time `PUBLIC_` var** — connected-repo *build* variables proved unreliable to keep set, so the whole feature rides on a single **runtime secret** `GOOGLE_STREETVIEW_KEY` (the embed key is public anyway — it's in the iframe URL). Additive and gated on that secret: unset → no Street View UI, nothing else changes.

**Write path (SSR, needs bindings).** `/submit` (`src/pages/submit.astro` + `src/components/SubmitForm.tsx`) downscales the photo in-browser, geocodes a typed place via Nominatim, and POSTs multipart to `src/pages/api/submit.ts`. That route:
1. Validates fields and the photo by **magic bytes** (not the browser content-type). JPG/PNG/WebP/HEIC only; **SVG is deliberately rejected** as an XSS vector.
2. Stores the photo in **R2** (`PHOTOS` binding) under an unguessable `sightings/<uuid>.<ext>` key.
3. Appends a row to the Google Sheet via an **Apps Script web app** (`apps-script/Code.gs`) with `status = "pending"`, authenticated with `SHEET_WEBHOOK_TOKEN`. Code.gs matches columns by header name (order-independent). Note: Apps Script returns HTTP 200 even when it rejects the token, so the route also checks the `ok` flag in the response body.

`src/pages/photos/[...key].ts` streams photos back out of R2.

**Admin moderation (`/admin`).** Officers sign in with a shared password and approve, defer, or reject the pending queue from the site. The page itself is static and holds nothing sensitive — the gate is the API: every `/api/admin/*` route checks a session first. `POST /api/admin/login` compares the submitted password against the `ADMIN_PASSWORD` runtime secret in **constant time** (`src/lib/admin-auth.ts`), then mints 256 bits of CSPRNG session id, stores it in `SESSION` KV under `admin_session:`, and returns it in an **HttpOnly, Secure, SameSite=Strict** cookie. The cookie carries no claims — it is only a KV lookup key, so a forged cookie is worthless and logout is a KV delete. SameSite=Strict is what makes the approve/reject POSTs CSRF-safe; the origin allowlist behind it is defence in depth. Failed logins are throttled per IP (8 per 15 min) in the same KV. `/api/admin/pending` and `/api/admin/status` proxy the Apps Script `listPending`/`setStatus` actions so `SHEET_WEBHOOK_TOKEN` never reaches the browser. Unset `ADMIN_PASSWORD` ⇒ every login refused (fail-closed).

Tradeoff worth knowing: one shared password means **no per-officer audit trail**, and rotating it signs everyone out. If this ever needs real identities, put Cloudflare Access (Zero Trust, Google SSO) in front of `/admin` and `/api/admin/*` and delete the password path — that is the upgrade, not more code here.

**Approval, the underlying model.** `parseCSV` hides any row whose `status` is exactly `"pending"`; blank/`active`/other stays visible (so pre-existing rows show). A submission lands as `pending`; you approve it by changing its `status` cell to `active` in the sheet. There is no admin UI. Caveat: a pending row sits in the single published tab, so its text and `/photos/<uuid>` URL are publicly fetchable before approval — they're just filtered out of the map client-side. (Cloudflare Turnstile bot protection is a planned Phase 2.)

## Bindings & deploy (`wrangler.jsonc`)

- `PHOTOS` (R2 bucket `poc-sticker-photos`) — submission photos. Create once: `wrangler r2 bucket create poc-sticker-photos`.
- `SESSION` (KV) — required by the Astro Cloudflare adapter (sessions on by default). The namespace id is **pinned** in `wrangler.jsonc`; do not let a deploy re-create it (fails with KV error 10014).
- `ASSETS` — serves the static `dist/` output.
- Secrets: `SHEET_WEBHOOK_URL`, `SHEET_WEBHOOK_TOKEN` (`wrangler secret put …`). Locally, put them in `.env`.
- Street View key (optional, one Google Cloud project — billing must be enabled but usage is $0): a single **runtime** secret `GOOGLE_STREETVIEW_KEY` (`wrangler secret put`, or `.env` locally) drives the whole feature — `/api/streetview` uses it for the coverage check and returns it to the client for the embed iframe. Restrict it to **Maps Embed API** + **Street View Static API** + HTTP referrers (`stickers.siddharthbobba.com/*`, `localhost:8787/*`). Do **not** use a build var — `astro build` runs on Cloudflare's connected-repo builder where build vars proved unreliable; runtime secrets are set with `wrangler secret put`. Optional `GOOGLE_MAPS_EMBED_KEY` splits the public embed key from the metadata key.
- CARTO basemap key (optional): runtime secret `CARTO_BASEMAP_KEY`, served to the client by `/api/basemap` and appended to each tile URL as `?key=`. Request one free at <https://carto.com/basemaps/apikey> (emailed back, no CARTO account needed; 5M tile requests/month, non-commercial, CARTO + OSM attribution must stay visible). Same runtime-secret reasoning as the Street View key — not a build var. Unset → the map falls back to the keyless Esri dark basemap. Note CARTO is retiring raster (PNG) tiles in favour of vector; the same key covers both when that lands.
- Admin password (required for `/admin`): runtime secret `ADMIN_PASSWORD`. Set it yourself with `wrangler secret put ADMIN_PASSWORD` — it should never be typed into a file. Unset means nobody can sign in; the queue fails closed.
- Deploy: pushing to `main` triggers a **Cloudflare connected-repo build** (runs `npm run build` and deploys the Worker; confirmed ~30s, no `.github/workflows`). `npm run deploy` (`wrangler deploy`) is the manual alternative. Deploy is locked to the custom domain `stickers.siddharthbobba.com` (`workers_dev: false`, `preview_urls: false`); the README's "deploy dist/ to any static host" note is stale — the submission routes require the Worker.

## Conventions

- **Security headers live in two places.** `src/middleware.ts` only runs for SSR routes; prerendered pages are served straight from the `ASSETS` binding and bypass Astro middleware entirely (before `public/_headers` existed, `/`, `/submit` and `/admin` shipped with no CSP, HSTS or framing protection at all — only `/api/*` was covered). `public/_headers` covers the static side. Keep the two header lists in sync. The CSP needs `blob:` in `img-src` for the submit form's local photo preview and `nominatim.openstreetmap.org` in `connect-src` for its geocoding — dropping either silently breaks /submit.
- Files carry a header comment explaining their role and the *why* behind security/edge-case decisions (see `src/pages/api/submit.ts`). Match that density when editing.
- `src/lib/stickers.ts` is intentionally pure — no `fetch`, no env access. Keep data-shaping logic there.
- Theme follows OS light/dark until the user explicitly toggles. The Leaflet basemap tracks the theme too (via a `MutationObserver` on `<html>`'s `data-theme` in `StickersMap.tsx`): an OpenStreetMap street map in light, **CARTO Dark Matter** in dark. CARTO tiles now need a key — keyless ones come back HTTP 200 with "API KEY REQUIRED" stamped across the PNG, so the watermark is the only symptom of a missing key. `StickersMap` gets the key as a `cartoKey` prop and appends it as `?key=`; with no key it falls back to **Esri Dark Gray Canvas** (keyless, labels in a second layer, native zoom capped at 16 hence `maxNativeZoom`), so the map is never watermarked in any state.
