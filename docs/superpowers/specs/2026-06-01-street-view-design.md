# Design: Google Street View for sticker points

**Date:** 2026-06-01
**Status:** Approved

## Goal

When a sticker point has Google Street View coverage, let a visitor view the
panorama **inline** (without leaving the site), reusing the existing
marker → drawer → full-screen-lightbox flow. Points with no coverage show no
Street View affordance at all.

## Decisions (settled during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Imagery source | **Google Maps Embed API, `streetview` mode** | Best global/US coverage; `streetview` embed is free + unlimited; trivial `location=lat,lng` → nearest-pano lookup. |
| Placement | **Tab in the full-screen lightbox** | A pano needs room to drag around; reuses `LocationModal`. The drawer gets a button that opens the lightbox straight to the pano. |
| No-coverage UX | **Pre-check, hide if none** | Remote/trail points often have no imagery; we never want to show Google's gray "no imagery" box. |
| Cost posture | Accept Google billing account (card on file) | User confirmed; usage is $0 but Google requires billing enabled for the key to function. |

## Architecture

Purely **additive** to the static read path, plus **one new SSR Worker route**
for the coverage pre-check. Google's Street View metadata endpoint is not
CORS-friendly, so the browser cannot call it directly — the check runs
server-side on the Worker (mirrors the existing `/api/submit`, `/photos`
pattern: `export const prerender = false` + `import { env } from 'cloudflare:workers'`).

### Two keys (different restrictions)

| Key | Lives | Restriction | Used for |
|---|---|---|---|
| `PUBLIC_GOOGLE_MAPS_EMBED_KEY` | Client (in the iframe URL); build-time `import.meta.env` | **Maps Embed API** + HTTP referrers (`stickers.siddharthbobba.com/*`, `localhost:*`) | Building the `streetview` iframe `src` |
| `GOOGLE_STREETVIEW_KEY` | Worker **secret** (`.env` locally, `wrangler secret put` in prod) | **Street View Static API** | Server-side metadata coverage check |

Two keys, not one, because:
- The embed key is **public** (visible in the iframe URL), so it must be
  HTTP-referrer-restricted — which means it cannot be used for a *server-side*
  call (no `Referer`).
- A referrer-restricted key can't sign the server-side metadata request, and we
  don't want the public iframe key to be usable on metered APIs if scraped.
- Metadata requests are free and consume no quota, so the second key's blast
  radius if leaked is negligible.

**Graceful degradation:** if `PUBLIC_GOOGLE_MAPS_EMBED_KEY` is unset, the Street
View UI never renders. The feature is additive; the site builds and runs exactly
as today without either key. If `GOOGLE_STREETVIEW_KEY` is unset, the route
returns `{ available: false }` and the button never appears.

## Components / changes

1. **`src/pages/api/streetview.ts`** *(new, `prerender = false`)*
   - `GET /api/streetview?lat=<n>&lng=<n>`
   - Validate/parse `lat`,`lng` (finite, in range); `400` on bad input.
   - Call `https://maps.googleapis.com/maps/api/streetview/metadata?location=lat,lng&radius=100&key=GOOGLE_STREETVIEW_KEY` server-side.
   - Return `{ available: boolean }` — `true` iff metadata `status === "OK"`.
   - **Fail-closed:** missing key, fetch error, or non-OK status → `{ available: false }` (the button simply won't show).
   - `Cache-Control: public, max-age=86400` — sticker points are stable, so coverage rarely changes.
   - Header comment explaining the CORS reason + key separation (per project convention).

2. **`src/components/LocationModal.tsx`**
   - New props: `embedKey?: string`, `initialView?: 'photo' | 'streetview'`.
   - Internal `view` state (`'photo' | 'streetview'`), seeded from `initialView`.
   - A **Photo | Street View** segmented toggle, rendered only when `embedKey` is
     present (the parent only opens streetview mode when coverage is known, so the
     toggle is meaningful).
   - In `streetview` view, render an `<iframe>` filling the photo area:
     `https://www.google.com/maps/embed/v1/streetview?key=<embedKey>&location=<lat>,<lng>`,
     `loading="lazy"`, `allowfullscreen`, a `title` for a11y, default referrer
     policy (the `Referer` is what satisfies the key's referrer restriction).
   - Keep Escape / backdrop / scroll-lock behavior.

3. **`src/components/LocationDrawer.tsx`**
   - New optional props: `streetViewAvailable?: boolean`, `onStreetView?: () => void`.
   - When `streetViewAvailable`, render a **🛣 Street View** button (alongside the
     existing "Full screen" control) that calls `onStreetView`.
   - Hidden when unavailable/unknown/no key.

4. **`src/components/StickerMapApp.tsx`**
   - Accept new prop `embedKey?: string`.
   - Replace `expanded: boolean` with `modalView: null | 'photo' | 'streetview'`
     (`null` = closed). Photo click / "Full screen" → `'photo'`; Street View
     button → `'streetview'`.
   - On marker select, if `embedKey` is set, `fetch('/api/streetview?lat=&lng=')`
     and store `streetViewAvailable` (reset per selection; ignore stale responses
     for a superseded selection).
   - Pass `embedKey` + `initialView` to `LocationModal`; pass
     `streetViewAvailable` + `onStreetView` to `LocationDrawer`.

5. **`src/pages/index.astro`**
   - Read `import.meta.env.PUBLIC_GOOGLE_MAPS_EMBED_KEY`, pass as `embedKey`
     (mirrors how `csvUrl` is read + passed).

6. **`src/env.d.ts`**
   - Add `GOOGLE_STREETVIEW_KEY: string` to `Cloudflare.Env`.
   - Add `PUBLIC_GOOGLE_MAPS_EMBED_KEY?: string` to `ImportMetaEnv`.

7. **Docs**: `.env.example` (both keys + Google Cloud setup note), `CLAUDE.md`
   (new route in the architecture section + the two keys), README env list.

## Data flow

```
marker click
  → setSelected(loc)                       (drawer opens)
  → GET /api/streetview?lat,lng            (if embedKey set)
      → Worker calls Google metadata
      → { available }
  → if available: drawer shows "Street View" button
  → click → modalView = 'streetview'
  → lightbox opens, iframe loads nearest pano
      (Google's own gray fallback covers the rare pre-check/iframe mismatch)
```

## Known nuances (baked in, not blockers)

- **Pre-check ≠ iframe pick.** The metadata `radius` (we use 100 m) and the
  embed's own "nearest panorama" logic can disagree at the margin. Accept rare
  mismatches; the iframe's built-in fallback covers the residual.
- **Button "pops in"** a beat after the drawer opens (async check). It's an
  additive overlay control, so no layout jump — no spinner needed.
- **Signing.** Metadata works with an API key alone at our volume; URL signing is
  "recommended" but only required for high-volume/enterprise — out of scope.

## Verification

No test runner in this project. Verify with:
- `npm run build` stays green (catches imports/syntax/module resolution).
- `npx astro check` if `@astrojs/check` is available (real type-check).
- `npm run preview` (exercises the Worker route + bindings): an urban point
  shows the button + pano; a remote point hides it; an unset embed key hides all
  Street View UI.
