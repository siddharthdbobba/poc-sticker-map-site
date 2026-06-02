/**
 * POST /api/submit
 *
 * Receives a sighting from the /submit page (multipart form):
 *   photo (File) + name, latitude, longitude, date, description, placedBy
 *
 * Flow: validate → store the photo in R2 (PHOTOS binding) → append a row to the
 * Google Sheet "Pending" tab via the Apps Script web app. The map never reads
 * Pending; the owner approves by moving the row to the Live tab (gid=0).
 *
 * Runs on the Worker (prerender = false) so it can reach the R2 binding and the
 * SHEET_WEBHOOK_* secrets via locals.runtime.env.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

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
  // Fail fast if submissions aren't wired up — don't orphan a photo in R2.
  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_TOKEN) {
    return json({ ok: false, error: 'Submissions are not configured yet.' }, 503);
  }

  // ── Photo is optional ────────────────────────────────────────────────────
  // If one was attached, validate it by magic bytes (never the browser-declared
  // type) and store it in R2. With no photo, the row's photo_url stays blank and
  // the map shows its 🗺️ placeholder for that pin.
  let photoUrl = '';
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
    photoUrl = new URL(`/photos/${key}`, request.url).toString();
  }

  // ── Append the row to the Google Sheet "Pending" tab ─────────────────────
  try {
    const res = await fetch(env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: env.SHEET_WEBHOOK_TOKEN,
        name,
        latitude,
        longitude,
        date,
        description,
        photo_url: photoUrl,
        placed_by: placedBy,
      }),
    });
    // Apps Script web apps return 200 even when they reject the token, so also
    // confirm the `ok` flag in the body.
    const text = await res.text();
    let ok = false;
    try {
      ok = (JSON.parse(text) as { ok?: boolean }).ok === true;
    } catch {
      ok = false;
    }
    if (!res.ok || !ok) throw new Error(`sheet webhook rejected (${res.status})`);
  } catch {
    // Photo is already stored; the row append is what failed. Surface a retryable error.
    return json({ ok: false, error: 'Could not record the sighting. Please try again later.' }, 502);
  }

  return json({ ok: true });
};
