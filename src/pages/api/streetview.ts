/**
 * GET /api/streetview?lat=<n>&lng=<n>
 *
 * Coverage pre-check for the Street View feature: reports { available: true }
 * only when Google has a panorama near the point. The map uses it to decide
 * whether to show the "Street View" button, so a remote / no-coverage point
 * never opens an empty gray embed.
 *
 * Why a server route (not a browser fetch): Google's Street View metadata
 * endpoint doesn't send CORS headers, so the client can't call it. Doing it here
 * also keeps the metadata key (GOOGLE_STREETVIEW_KEY) server-side, separate from
 * the public, referrer-restricted embed key (PUBLIC_GOOGLE_MAPS_EMBED_KEY) —
 * a referrer-restricted key can't authorize a server-side request. Metadata
 * requests are free and consume no quota.
 *
 * Fail-closed: a missing key, a non-OK Google status, or any error → available:
 * false, so the feature stays hidden rather than surfacing an error.
 *
 * Runs on the Worker (prerender = false) to read GOOGLE_STREETVIEW_KEY.
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

export const GET: APIRoute = async ({ url }) => {
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
    if (data.status === 'OK') return json({ available: true }, true);
    if (data.status === 'ZERO_RESULTS' || data.status === 'NOT_FOUND') {
      return json({ available: false }, true);
    }
    return json({ available: false }, false);
  } catch {
    return json({ available: false }, false);
  }
};
