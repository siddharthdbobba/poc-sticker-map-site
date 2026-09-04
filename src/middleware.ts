/**
 * Astro middleware that adds security headers to every response (SSR and
 * static pages served through the Worker). This is the server-side security
 * layer — headers like CSP, HSTS, and X-Frame-Options are applied here rather
 * than relying on a reverse proxy or edge config, because the site deploys
 * directly to Cloudflare Workers (no proxy in front).
 *
 * The CSP is intentionally permissive enough to allow:
 *   - Leaflet map tiles (OSM, CARTO)
 *   - Google Maps Embed (Street View iframe)
 *   - Google Docs viewer (info modal iframe)
 *   - Inline scripts/styles (React hydration, Astro islands)
 *   - data: URIs for images (Leaflet marker icons)
 *
 * See each header below for the rationale.
 */

import type { MiddlewareHandler } from 'astro';

export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();

  // Clone the headers so we don't mutate the original response's header list
  // in a way that breaks the immutable contract.
  const headers = new Headers(response.headers);

  // ── Content-Security-Policy ──────────────────────────────────────────────
  // Tight default: only same-origin. Exceptions granted per resource type.
  // 'unsafe-inline' / 'unsafe-eval' needed for Astro's hydration island
  // scripts and React in dev/prod. Tile sources: OSM (standard street) and
  // CARTO (dark theme). connect-src includes docs.google.com for the
  // spreadsheet export, plus Nominatim for the submit form's geocoding.
  // img-src needs blob: for the submit form's local photo preview
  // (URL.createObjectURL). frame-src covers the Street View embed and the
  // Google Docs viewer fallback. form-action locked to self.
  //
  // NOTE: this block only reaches SSR routes. Prerendered pages bypass
  // middleware entirely and get the same headers from public/_headers —
  // keep the two in sync.
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.basemaps.cartocdn.com https://server.arcgisonline.com; " +
      "font-src 'self'; " +
      "connect-src 'self' https://docs.google.com https://nominatim.openstreetmap.org; " +
      "frame-src 'self' https://www.google.com; " +
      "object-src 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'",
  );

  // ── Strict-Transport-Security ───────────────────────────────────────────
  // Enforce HTTPS for one year, including all subdomains, and request
  // preload inclusion from browser vendors. Safe for this deployment since
  // the custom domain (stickers.siddharthbobba.com) already serves HTTPS.
  headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload',
  );

  // ── X-Content-Type-Options ──────────────────────────────────────────────
  // Prevent MIME-type sniffing — browsers must honour the declared
  // Content-Type. Essential for script/style resources served from R2
  // (/photos/...) that could otherwise be interpreted as a different type.
  headers.set('X-Content-Type-Options', 'nosniff');

  // ── X-Frame-Options ─────────────────────────────────────────────────────
  // Only this site may embed pages in an <iframe>, <frame>, or <object>.
  // This is a defence-in-depth layer for CSP's frame-ancestors directive;
  // Astro's Cloudflare adapter doesn't set it on its own.
  headers.set('X-Frame-Options', 'SAMEORIGIN');

  // ── Referrer-Policy ─────────────────────────────────────────────────────
  // Send the full origin+path when staying on the same origin (for logging,
  // analytics), but strip down to origin only when navigating cross-origin
  // (no query params or paths leaked). This is a good default for most sites.
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // ── Permissions-Policy ──────────────────────────────────────────────────
  // Explicitly disable camera, microphone, and geolocation. This site
  // doesn't use any of these — they're locked down so even if a third-party
  // script managed to run, it couldn't access them.
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );

  // ── X-Robots-Tag (admin only) ───────────────────────────────────────────
  // Keep the moderation queue and its API out of search results. This is
  // hygiene, not access control — the gate is the session check in
  // /api/admin/*, which is what actually stops an anonymous request.
  if (context.url.pathname.startsWith('/admin') || context.url.pathname.startsWith('/api/admin')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
