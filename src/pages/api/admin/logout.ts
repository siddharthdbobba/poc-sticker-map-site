/**
 * POST /api/admin/logout → revokes the session and clears the cookie.
 *
 * Revoking in KV (not just clearing the cookie) is the point: a cookie already
 * copied elsewhere stops working too.
 *
 * Runs on the Worker (prerender = false) to reach SESSION KV.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { clearedCookie, destroySession, json, originAllowed } from '../../../lib/admin-auth';

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  if (!originAllowed(request)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  await destroySession(request, env.SESSION);
  return json({ ok: true }, 200, clearedCookie(url));
};
