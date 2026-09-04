/**
 * admin-auth.ts
 *
 * Session helpers shared by the /api/admin/* routes. Kept together so the
 * security decisions live in one place rather than being re-derived per route.
 *
 * The model is deliberately small: one shared password (the ADMIN_PASSWORD
 * runtime secret) is exchanged for an opaque random session id, which is stored
 * in the SESSION KV namespace and handed back in an HttpOnly cookie. The cookie
 * carries no claims of its own — it is only a lookup key — so a forged or edited
 * cookie is worthless without a matching KV entry, and revoking a session is a
 * KV delete.
 *
 * Why a shared password rather than per-user accounts: the audience is a couple
 * of club officers, and account management (invites, resets, recovery) would be
 * more attack surface than the thing it protects. The tradeoff is real and worth
 * knowing: there is no per-officer audit trail, and rotating the password logs
 * everyone out. See CLAUDE.md for the Cloudflare Access upgrade path if this
 * ever needs real identities.
 *
 * This module does no I/O of its own beyond the KV handle it is given, so the
 * routes stay responsible for env access — same split as src/lib/stickers.ts.
 */

// KVNamespace is a global from the wrangler-generated worker-configuration.d.ts
// (`npm run generate-types`) — @cloudflare/workers-types is not a dependency
// here, so importing the type from it would not resolve.

/** Cookie name. Prefixed so it can't collide with the adapter's own session. */
export const SESSION_COOKIE = 'poc_admin_session';

/** KV key prefix, so admin sessions can't collide with adapter session keys. */
const SESSION_PREFIX = 'admin_session:';

/** How long a login lasts. Short enough that a forgotten open tab expires. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** Failed-login throttling, keyed by client IP. */
const LOGIN_FAIL_PREFIX = 'admin_login_fail:';
const MAX_FAILED_LOGINS = 8;
const FAIL_WINDOW_SECONDS = 15 * 60;

/**
 * Constant-time string comparison. A plain `===` on a secret leaks its length
 * and, in principle, its prefix through timing. Hashing both sides first gives
 * two fixed-length digests, so the byte loop below always runs the same number
 * of iterations regardless of the inputs.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Read one cookie out of a request's Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Mint a session and store it in KV. The id is 256 bits of CSPRNG output — not
 * derived from the password, so it discloses nothing about it.
 */
export async function createSession(kv: KVNamespace): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await kv.put(SESSION_PREFIX + id, JSON.stringify({ createdAt: Date.now() }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return id;
}

/** True when the request carries a cookie naming a live session. */
export async function isAuthenticated(
  request: Request,
  kv: KVNamespace | undefined,
): Promise<boolean> {
  if (!kv) return false;
  const id = readCookie(request, SESSION_COOKIE);
  // Shape check first: a malformed cookie should never reach KV as a lookup.
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return false;
  return (await kv.get(SESSION_PREFIX + id)) !== null;
}

/** Revoke the session named by the request's cookie, if any. */
export async function destroySession(
  request: Request,
  kv: KVNamespace | undefined,
): Promise<void> {
  if (!kv) return;
  const id = readCookie(request, SESSION_COOKIE);
  if (id && /^[0-9a-f]{64}$/.test(id)) await kv.delete(SESSION_PREFIX + id);
}

/**
 * Cookie attributes: HttpOnly keeps it away from any script (so an XSS on the
 * public map can't lift it), Secure pins it to HTTPS, and SameSite=Strict means
 * a cross-site form or fetch can never ride along with it — which is what makes
 * the approve/reject POSTs CSRF-safe without a separate token. Max-Age matches
 * the KV TTL so the browser and the server expire together.
 *
 * Secure is dropped on plain-HTTP localhost only, since `npm run preview` serves
 * http://localhost:8787 and a Secure cookie would be silently discarded there.
 */
export function sessionCookie(id: string, url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return (
    `${SESSION_COOKIE}=${id}; HttpOnly;${secure} SameSite=Strict; ` +
    `Path=/; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

/** An immediately-expiring cookie, for logout. */
export function clearedCookie(url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${SESSION_COOKIE}=; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Throttle failed logins per IP so the shared password can't be ground down by
 * brute force. Counting only *failures* means a working session is never
 * penalised. Fail-open when KV is unavailable: losing the counter should not
 * lock the officers out of their own moderation queue.
 */
export async function isRateLimited(
  ip: string,
  kv: KVNamespace | undefined,
): Promise<boolean> {
  if (!kv || !ip) return false;
  const raw = await kv.get(LOGIN_FAIL_PREFIX + ip);
  return raw !== null && Number(raw) >= MAX_FAILED_LOGINS;
}

/** Record one failed attempt, restarting the window on each new failure. */
export async function recordFailedLogin(
  ip: string,
  kv: KVNamespace | undefined,
): Promise<void> {
  if (!kv || !ip) return;
  const raw = await kv.get(LOGIN_FAIL_PREFIX + ip);
  const next = (raw === null ? 0 : Number(raw)) + 1;
  await kv.put(LOGIN_FAIL_PREFIX + ip, String(next), {
    expirationTtl: FAIL_WINDOW_SECONDS,
  });
}

/** Clear the failure counter after a successful login. */
export async function clearFailedLogins(
  ip: string,
  kv: KVNamespace | undefined,
): Promise<void> {
  if (!kv || !ip) return;
  await kv.delete(LOGIN_FAIL_PREFIX + ip);
}

/** Client IP as Cloudflare sees it. Empty string when unavailable (local dev). */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? '';
}

/**
 * Origin allowlist, mirroring /api/streetview and /api/basemap. On the admin
 * routes this is defence in depth behind SameSite=Strict, not the primary CSRF
 * control.
 */
const ALLOWED_ORIGINS = [
  'https://stickers.siddharthbobba.com',
  'http://localhost:8787',
  'http://localhost:4321',
];

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (origin) return ALLOWED_ORIGINS.includes(origin);
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return ALLOWED_ORIGINS.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}

/** Uniform JSON response helper. Admin responses are never cached. */
export function json(data: unknown, status = 200, cookie?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}
