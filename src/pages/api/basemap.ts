/**
 * GET /api/basemap
 *
 * Source of the CARTO basemap key. Returns { cartoKey } — the empty string when
 * no key is configured, which the map reads as "fall back to the keyless
 * basemap" rather than as an error.
 *
 * Why this exists: CARTO now stamps "API KEY REQUIRED" across tiles served from
 * basemaps.cartocdn.com without a key. The tiles still come back HTTP 200 with a
 * valid PNG, so there is no loud failure — the watermark is the only symptom.
 * A key (free tier) removes it.
 *
 * Why a server route (not a build-time PUBLIC_ var): same reasoning as
 * /api/streetview. Connected-repo *build* variables proved unreliable to keep
 * set on this deployment, so the key rides on a runtime secret
 * (CARTO_BASEMAP_KEY). The key is public anyway — it appears in every tile URL
 * the browser requests — so handing it to the client is not a leak. Restrict it
 * to this domain in the CARTO dashboard, the same way the Street View key is
 * referrer-restricted.
 *
 * Fail-soft: a missing key is a normal state, not an error. The map renders the
 * keyless Esri dark basemap instead, so it is never watermarked.
 *
 * Runs on the Worker (prerender = false) to read CARTO_BASEMAP_KEY.
 *
 * Origin restriction: mirrors /api/streetview — only requests whose Origin or
 * Referer matches the deployment domain (or localhost in dev) get an answer, so
 * this endpoint can't be used to hand out the key to third-party sites.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

// Same allowlist as /api/streetview: the deployed domain, plus localhost for
// `npm run preview` (8787) and `npm run dev` (4321).
const ALLOWED_ORIGINS = [
  'https://stickers.siddharthbobba.com',
  'http://localhost:8787',
  'http://localhost:4321',
];

/**
 * Extract the origin from the Request's Origin or Referer header. Origin is
 * preferred when present (CORS requests always send it); Referer is a
 * reasonable fallback for same-origin navigations where the browser omits
 * Origin. Returns null when neither header is present or parseable.
 */
function getRequestOrigin(request: Request): string | null {
  const origin = request.headers.get('Origin');
  if (origin) return origin;

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // Malformed URL — treat as unverifiable.
    }
  }
  return null;
}

export const GET: APIRoute = async ({ request }) => {
  const reqOrigin = getRequestOrigin(request);
  if (!reqOrigin || !ALLOWED_ORIGINS.includes(reqOrigin)) {
    return new Response(
      JSON.stringify({ error: 'forbidden', message: 'unauthorized origin' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const cartoKey = env.CARTO_BASEMAP_KEY ?? '';

  return new Response(JSON.stringify({ cartoKey }), {
    headers: {
      'Content-Type': 'application/json',
      // Short cache: long enough to skip a round trip on repeat views, short
      // enough that setting or rotating the secret takes effect quickly.
      'Cache-Control': cartoKey ? 'public, max-age=3600' : 'no-store',
    },
  });
};
