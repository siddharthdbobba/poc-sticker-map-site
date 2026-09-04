# Repository Guidelines

## Project Structure & Module Organization

This Astro 6 site renders a Purdue Outing Club sticker map and Cloudflare Worker routes. Pages live in `src/pages/`, including `index.astro`, `submit.astro`, `api/submit.ts`, `api/streetview.ts`, and `photos/[...key].ts`. React map UI is in `src/components/`, shared parsing lives in `src/lib/stickers.ts`, layout and global CSS live in `src/layouts/` and `src/styles/`, and Apps Script integration is in `apps-script/Code.gs`. Worker bindings are configured in `wrangler.jsonc`.

## Build, Test, and Development Commands

- `npm install` installs dependencies; use Node `>=22.12.0`.
- `npm run dev` starts Astro locally at `http://localhost:4321`.
- `npm run build` emits `dist/` and catches build-breaking import/syntax/module errors, but not full TypeScript type errors.
- `npm run preview` builds and serves through `wrangler dev`; use it for Worker routes, R2, KV, and secrets.
- `npm run generate-types` refreshes Cloudflare binding types.
- `npm run deploy` builds and deploys with Wrangler.

## Coding Style & Naming Conventions

Use TypeScript, Astro components for pages/layouts, and React only for interactive islands. Component files use `PascalCase.tsx`; utilities use `camelCase.ts`. Keep `src/lib/stickers.ts` pure: no `fetch` or env access. Keep server-only logic in API routes, and preserve Leaflet's theme-aware basemap behavior.

## Testing Guidelines

No test script or linter is currently configured. Use `npm run build` as the required verification step. For Worker paths, also use `npm run preview`, because `astro dev` does not exercise bindings. Manually test map loading, marker modals, submissions, photo serving, and Street View when touching those paths.

## Commit & Pull Request Guidelines

Recent commits use concise imperative messages such as `Security hardening: headers middleware...` and `Add inline Google Street View for sticker points`. PRs should include affected routes, environment or Wrangler changes, manual verification, and screenshots for UI changes.

## Security & Configuration Tips

Copy `.env.example` to `.env`. Required runtime secrets include `SHEET_WEBHOOK_URL`, `SHEET_WEBHOOK_TOKEN`, and optionally `GOOGLE_STREETVIEW_KEY`; do not replace the Street View runtime secret with a build-time `PUBLIC_` variable. Keep R2 uploads, origin checks, and security headers intact. `SESSION` KV is pinned in `wrangler.jsonc`; do not recreate it during deploy.
