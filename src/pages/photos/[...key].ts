/**
 * GET /photos/<key>
 *
 * Streams a sticker photo back from R2 (PHOTOS binding). The key is everything
 * after /photos/, e.g. "sightings/<uuid>.jpg" — exactly what /api/submit stored.
 *
 * Runs on the Worker (prerender = false) for the R2 binding.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const key = params.key;
  if (!key) return new Response('Not found', { status: 404 });

  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers); // Content-Type etc. from the stored metadata
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  // User-uploaded bytes served from our own domain — never let the browser sniff
  // a different (e.g. HTML) type out of them.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('ETag', obj.httpEtag);

  return new Response(obj.body, { headers });
};
