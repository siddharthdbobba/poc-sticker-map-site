/**
 * POST /api/submit
 *
 * Receives a sighting from the /submit page (multipart form):
 *   photo (File) + name, latitude, longitude, date, description, placedBy
 *
 * Flow: validate → store the photo in R2 (PHOTOS binding) → put the submission
 * in the KV moderation queue (see src/lib/pending.ts).
 *
 * It deliberately does NOT touch the Google Sheet. The sheet is shared "anyone
 * with the link can view", so anything written there is public immediately —
 * a row marked "pending" was hidden from the map by client-side filtering only,
 * while its text, coordinates and photo URL were readable by anyone. Unapproved
 * content therefore never goes near it: approving a submission in /admin is what
 * writes the row.
 *
 * Runs on the Worker (prerender = false) so it can reach the R2 and KV bindings.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { clientIp, overRateLimit } from '../../lib/admin-auth';
import { putPending } from '../../lib/pending';

export const prerender = false;

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Per-IP submission cap. This endpoint writes an R2 object and a spreadsheet row
 * on every accepted call, and the origin check in front of it is a CSRF control,
 * not an identity one — a script can set its own headers. Without a cap, one
 * caller can fill the bucket and the sheet.
 *
 * The numbers are set for the real use: someone standing at a trailhead adding
 * the two or three stickers they just found. Ten in an hour is generous for
 * that, and hostile for anyone bulk-posting. Counted per IP, so a whole club
 * trip sharing one hotspot is the case to watch — hence "an hour", not "a day".
 *
 * Not a substitute for Cloudflare Turnstile (still unbuilt), which is what stops
 * a distributed bot rather than a single noisy source.
 */
const SUBMIT_LIMIT = 10;
const SUBMIT_WINDOW_SECONDS = 60 * 60;

/**
 * Identify the image by its magic bytes — we do NOT trust the browser-declared
 * content-type. SVG is intentionally unsupported: it can carry script and would
 * be an XSS vector served back from our own domain.
 * Returns a safe content-type + extension, or null if it isn't a known image.
 */
function sniffImage(b: Uint8Array): { contentType: string; ext: string } | null {
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { contentType: 'image/png', ext: 'png' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  // HEIC/HEIF: ISO-BMFF "ftyp" box at offset 4 with an Apple/HEIF brand.
  // (May not render in non-Apple browsers — the client converts to JPEG when it
  // can; only undecodable HEIC reaches here. Accepted so submissions don't fail.)
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (['heic', 'heix', 'heif', 'hevc', 'mif1', 'msf1'].includes(brand)) {
      return { contentType: 'image/heic', ext: 'heic' };
    }
  }
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // ── Origin / Referer check (CSRF mitigation) ────────────────────────────
  // Only accepts POSTs that originated from the sticker map domain. This
  // prevents off-site forms from submitting fake sightings via this endpoint.
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  const ALLOWED_ORIGINS = [
    'https://stickers.siddharthbobba.com',
    'http://localhost:8787',
    'http://localhost:4321',
  ];
  // Origin must match EXACTLY. A prefix test would accept
  // https://stickers.siddharthbobba.com.evil.example, which starts with the
  // allowed value but is a different site entirely. Referer legitimately
  // carries a path, so it is compared by parsed origin rather than by prefix.
  const refererOrigin = (() => {
    try {
      return referer ? new URL(referer).origin : '';
    } catch {
      return '';
    }
  })();
  // When Origin is present it is authoritative: a request that declares a
  // foreign origin must not be rescued by a Referer that happens to look right.
  // Referer is only consulted when Origin is absent, which is the same-origin
  // navigation case browsers omit it for.
  const isAllowed =
    origin !== ''
      ? ALLOWED_ORIGINS.includes(origin)
      : refererOrigin !== '' && ALLOWED_ORIGINS.includes(refererOrigin);
  if (!origin && !referer) {
    // No referrer info at all — likely a direct curl/wget. Reject.
    return json({ ok: false, error: 'Missing origin.' }, 403);
  }
  if (!isAllowed) {
    return json({ ok: false, error: 'Unauthorized origin.' }, 403);
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  // Before parsing the body, so a flood costs us a KV read rather than an 8 MB
  // multipart parse.
  if (await overRateLimit('submit', clientIp(request), env.SESSION, SUBMIT_LIMIT, SUBMIT_WINDOW_SECONDS)) {
    return json(
      { ok: false, error: 'That is a lot of sightings at once — try again in an hour.' },
      429,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Expected a multipart form submission.' }, 400);
  }

  const photo = form.get('photo');
  const name = String(form.get('name') ?? '').trim();
  const latitude = parseFloat(String(form.get('latitude') ?? ''));
  const longitude = parseFloat(String(form.get('longitude') ?? ''));
  const date = String(form.get('date') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const placedBy = String(form.get('placedBy') ?? '').trim();

  // ── Validate fields ──────────────────────────────────────────────────────
  if (!name) {
    return json({ ok: false, error: 'A location name is required.' }, 400);
  }
  if (
    !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
  ) {
    return json({ ok: false, error: 'Choose a valid location from the search.' }, 400);
  }
  // Fail fast if the queue isn't wired up — don't orphan a photo in R2.
  if (!env.SESSION) {
    return json({ ok: false, error: 'Submissions are not configured yet.' }, 503);
  }

  // ── Photo is optional ────────────────────────────────────────────────────
  // If one was attached, validate it by magic bytes (never the browser-declared
  // type) and store it in R2. With no photo, the row's photo_url stays blank and
  // the map shows its 🗺️ placeholder for that pin.
  let photoUrl = '';
  let photoKey = '';
  if (photo instanceof File && photo.size > 0) {
    if (photo.size > MAX_BYTES) {
      return json({ ok: false, error: 'Photo is too large (8 MB max).' }, 413);
    }
    const buf = await photo.arrayBuffer();
    const sniff = sniffImage(new Uint8Array(buf.slice(0, 16)));
    if (!sniff) {
      return json({ ok: false, error: 'Unsupported image. Use JPG, PNG, WebP, or HEIC.' }, 415);
    }
    // Store the photo in R2 under an unguessable key.
    const key = `sightings/${crypto.randomUUID()}.${sniff.ext}`;
    await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: sniff.contentType } });
    photoKey = key;
    photoUrl = new URL(`/photos/${key}`, request.url).toString();
  }

  // ── Queue it for review ──────────────────────────────────────────────────
  // KV, not the sheet: see the header comment. Nothing here is public until an
  // officer approves it.
  try {
    await putPending(env.SESSION, {
      id: crypto.randomUUID(),
      name,
      latitude,
      longitude,
      date,
      description,
      photoUrl,
      photoKey,
      placedBy,
      submittedAt: new Date().toISOString(),
    });
  } catch {
    // The photo is already stored; the queue write is what failed. Retryable.
    return json({ ok: false, error: 'Could not record the sighting. Please try again later.' }, 502);
  }

  return json({ ok: true });
};
