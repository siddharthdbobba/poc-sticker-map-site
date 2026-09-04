/**
 * POST /api/admin/login   { password }  → sets the admin session cookie
 * GET  /api/admin/login                 → { authenticated: boolean }
 *
 * The GET exists so the admin page can ask "am I already logged in?" on load
 * without POSTing a password or leaking anything to an anonymous caller.
 *
 * Fail-closed: if ADMIN_PASSWORD is unset, every login attempt is refused. The
 * moderation queue is never reachable "because the secret wasn't configured".
 *
 * Runs on the Worker (prerender = false) to read ADMIN_PASSWORD and SESSION KV.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  clearFailedLogins,
  clientIp,
  createSession,
  isAuthenticated,
  isRateLimited,
  json,
  originAllowed,
  recordFailedLogin,
  sessionCookie,
  timingSafeEqual,
} from '../../../lib/admin-auth';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authenticated = await isAuthenticated(request, env.SESSION);
  return json({ authenticated });
};

export const POST: APIRoute = async ({ request, url }) => {
  if (!originAllowed(request)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  const ip = clientIp(request);
  if (await isRateLimited(ip, env.SESSION)) {
    // Deliberately vague, and identical in shape to a wrong password: an
    // attacker shouldn't learn whether they've been throttled or simply missed.
    return json({ ok: false, error: 'too many attempts' }, 429);
  }

  let password = '';
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === 'string' ? body.password : '';
  } catch {
    return json({ ok: false, error: 'bad request' }, 400);
  }

  const expected = env.ADMIN_PASSWORD ?? '';
  // Compare even when unconfigured, so an unset secret takes the same time as a
  // wrong password rather than answering instantly.
  const ok = (await timingSafeEqual(password, expected)) && expected !== '';

  if (!ok) {
    await recordFailedLogin(ip, env.SESSION);
    return json({ ok: false, error: 'invalid password' }, 401);
  }

  if (!env.SESSION) {
    return json({ ok: false, error: 'session store unavailable' }, 500);
  }

  await clearFailedLogins(ip, env.SESSION);
  const id = await createSession(env.SESSION);
  return json({ ok: true }, 200, sessionCookie(id, url));
};
