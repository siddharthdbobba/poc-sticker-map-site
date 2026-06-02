/// <reference types="astro/client" />

// Secrets are set with `wrangler secret put` (not declared in wrangler.jsonc),
// so they don't appear in the generated Cloudflare.Env in worker-configuration.d.ts.
// Declaration-merge them so `import { env } from "cloudflare:workers"` stays typed.
// (PHOTOS / SESSION / ASSETS come from the generated file.)
declare namespace Cloudflare {
  interface Env {
    /** Apps Script web-app `/exec` URL that appends a row to the Pending tab. */
    SHEET_WEBHOOK_URL: string;
    /** Shared secret echoed to the Apps Script web app to authorize the append. */
    SHEET_WEBHOOK_TOKEN: string;
    /** Cloudflare Turnstile secret key (Phase 2 — optional until configured). */
    TURNSTILE_SECRET_KEY?: string;
    /**
     * Google Maps API key for the SERVER-SIDE Street View metadata pre-check
     * (/api/streetview). Restrict it to the Street View Static API. Optional —
     * if unset, the coverage check returns { available: false } and no Street
     * View UI ever appears. Distinct from PUBLIC_GOOGLE_MAPS_EMBED_KEY because a
     * referrer-restricted public key can't authorize a server-side request.
     */
    GOOGLE_STREETVIEW_KEY?: string;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_STICKER_CSV_URL?: string;
  readonly PUBLIC_STICKER_FORM_URL?: string;
  /** Cloudflare Turnstile site key (Phase 2 — public, embedded in the form). */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
  /**
   * Google Maps API key for the CLIENT-SIDE Street View embed iframe. It is
   * public (visible in the iframe URL), so restrict it to the Maps Embed API +
   * HTTP referrers. Optional — if unset, no Street View UI renders.
   */
  readonly PUBLIC_GOOGLE_MAPS_EMBED_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
