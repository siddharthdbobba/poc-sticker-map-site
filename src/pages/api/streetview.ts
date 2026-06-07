/**
 * GET /api/streetview?lat=<n>&lng=<n>
 *
 * Coverage pre-check for the Street View feature, and source of the embed key.
 * Reports { available: true, embedKey } only when Google has a panorama near the
 * point. The map uses `available` to decide whether to show the "Street View"
 * button (so a no-coverage point never opens an empty gray embed) and `embedKey`
 * to build the iframe URL.
 *
 * Why a server route (not a browser fetch): Google's Street View metadata
 * endpoint doesn't send CORS headers, so the client can't call it. Doing it here
 * also lets the whole feature ride on a single RUNTIME secret
 * (GOOGLE_STREETVIEW_KEY) — the embed key is public anyway (it appears in the
 * iframe URL), and connected-repo *build* variables proved unreliable to keep
 * set, so we deliberately avoid a build-time PUBLIC_ var. Metadata requests are
 * free and consume no quota.
 *
 * Fail-closed: a missing key, a non-OK Google status, or any error → available:
 * false, so the feature stays hidden rather than surfacing an error.
 *
 * Runs on the Worker (prerender = false) to read GOOGLE_STREETVIEW_KEY.
 *
 * Origin restriction: this endpoint only responds to requests whose Origin or
 * Referer header matches stickers.siddharthbobba.com (the deployment domain).
 * This prevents third-party sites from abusing the Google Street View metadata
 * API through this proxy. 403 is returned for unauthorized origins.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

// Search radius (metres) for the nearest panorama. Kept modest so we don't
// advertise a pano that's actually far from the point. The embed iframe makes
// its own "nearest panorama" pick, so this is a strong — not exact — predictor.
const SEARCH_RADIUS_M = 100;

/**
 * `cacheable` is true only for a *definitive* Google answer (a pano exists or
 * provably doesn't): coverage for a fixed point is stable, so cache it a day.
 * Config/error states use no-store so they clear the moment the key is set or
 * Google recovers — we never want to pin a transient failure as a hard "no".
 */
function json(data: unknown, cacheable: boolean, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-store',
    },
  });
}

// Allowed origins that may call this endpoint. The deployed site domain is the
// primary allowed origin; localhost is permitted for development.
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

export const GET: APIRoute = async ({ url, request }) => {
  // ── Origin check ─────────────────────────────────────────────────────────
  // Verify the request comes from our deployed site. This prevents third-party
  // sites from abusing this endpoint as a Google Street View metadata proxy.
  // We check Origin first (set by all CORS/API requests), then fall back to
  // Referer (set by same-origin navigations). Requests without either header
  // (e.g. raw curl) are rejected.
  const reqOrigin = getRequestOrigin(request);
  if (!reqOrigin || !ALLOWED_ORIGINS.includes(reqOrigin)) {
    return new Response(
      JSON.stringify({ error: 'forbidden', message: 'unauthorized origin' }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
  const lat = parseFloat(url.searchParams.get('lat') ?? '');
  const lng = parseFloat(url.searchParams.get('lng') ?? '');

  if (
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    return json({ available: false, error: 'bad coordinates' }, false, 400);
  }

  // Feature off (no key configured) — stay quiet, just report unavailable.
  if (!env.GOOGLE_STREETVIEW_KEY) return json({ available: false }, false);

  // No `source` param → include all panorama types (Google cars + photospheres),
  // matching what the embed iframe's `location=` picks by default.
  const metaUrl =
    'https://maps.googleapis.com/maps/api/streetview/metadata' +
    `?location=${lat},${lng}&radius=${SEARCH_RADIUS_M}` +
    `&key=${encodeURIComponent(env.GOOGLE_STREETVIEW_KEY)}`;

  try {
    // Send a Referer matching this deployment's origin so a *single*
    // HTTP-referrer-restricted key (the same one used in the public embed
    // iframe) also authorizes this server-side call. Harmless if the key has no
    // referrer restriction (a dedicated, unrestricted metadata key still works).
    const res = await fetch(metaUrl, { headers: { Referer: `${url.origin}/` } });
    if (!res.ok) return json({ available: false }, false);
    const data = (await res.json()) as { status?: string };
    // "OK" → a pano exists. "ZERO_RESULTS" / "NOT_FOUND" → definitively none.
    // Anything else (OVER_QUERY_LIMIT, REQUEST_DENIED, …) is transient/config —
    // don't cache it as a hard "no".
    if (data.status === 'OK') {
      // Hand the embed key to the client here rather than via a build-time
      // PUBLIC_ var, so the whole feature rides on runtime secrets only (build
      // variables proved unreliable to keep set on the connected-repo build).
      // The embed key is public anyway — it appears in the iframe URL. Prefer a
      // dedicated embed key if configured, else reuse the single Street View key.
      const embedKey = env.GOOGLE_MAPS_EMBED_KEY || env.GOOGLE_STREETVIEW_KEY;
      return json({ available: true, embedKey }, true);
    }
    if (data.status === 'ZERO_RESULTS' || data.status === 'NOT_FOUND') {
      return json({ available: false }, true);
    }
    return json({ available: false }, false);
  } catch {
    return json({ available: false }, false);
  }
};
