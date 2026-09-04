/**
 * POST /api/admin/status  { photo_url?, row?, status } → { ok }
 *
 * Proxies the Apps Script `setStatus` action, mapping the admin UI's verdicts
 * onto the statuses src/lib/stickers.ts understands:
 *   approve → "active" (visible on the map)
 *   reject  → "rejected" (hidden)
 *   defer   → "review"   (hidden, revisit later)
 *
 * Identification: Apps Script matches a row by photo_url, which is unique and
 * survives rows moving between the list and the write. But the submit form makes
 * the photo OPTIONAL, so a photo-less pending row has no photo_url to match on
 * and cannot be addressed that way. Those rows carry a `row` number from
 * listPending instead, which the updated apps-script/Code.gs accepts (and
 * re-checks is still pending before writing, so a stale number can't clobber an
 * already-moderated row). Both identifiers are forwarded when available: an
 * older Code.gs deployment ignores `row` and still works for photo rows.
 *
 * Runs on the Worker (prerender = false) for SESSION KV + SHEET_WEBHOOK_*.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthenticated, json, originAllowed } from '../../../lib/admin-auth';

export const prerender = false;

/** Only these three are reachable from the UI; "pending" is not a verdict. */
const ALLOWED_STATUSES = ['active', 'rejected', 'review'];

export const POST: APIRoute = async ({ request }) => {
  if (!originAllowed(request)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  if (!(await isAuthenticated(request, env.SESSION))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_TOKEN) {
    return json({ ok: false, error: 'Moderation is not configured yet.' }, 503);
  }

  let photoUrl = '';
  let row: number | undefined;
  let status = '';
  try {
    const body = (await request.json()) as {
      photo_url?: unknown;
      row?: unknown;
      status?: unknown;
    };
    photoUrl = typeof body.photo_url === 'string' ? body.photo_url : '';
    row = typeof body.row === 'number' && Number.isInteger(body.row) ? body.row : undefined;
    status = typeof body.status === 'string' ? body.status : '';
  } catch {
    return json({ ok: false, error: 'bad request' }, 400);
  }

  if (!ALLOWED_STATUSES.includes(status)) {
    return json({ ok: false, error: 'bad status' }, 400);
  }
  if (!photoUrl && row === undefined) {
    return json({ ok: false, error: 'photo_url or row required' }, 400);
  }

  try {
    const res = await fetch(env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: env.SHEET_WEBHOOK_TOKEN,
        action: 'setStatus',
        photo_url: photoUrl,
        row,
        status,
      }),
    });
    const text = await res.text();
    let parsed: { ok?: boolean; error?: string };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error('sheet webhook returned non-JSON');
    }
    if (!res.ok || parsed.ok !== true) {
      // Surface the Apps Script reason — "photo_url not found" usually means the
      // row was already moderated in the sheet, which the officer should see
      // rather than read as a generic failure.
      return json({ ok: false, error: parsed.error ?? 'sheet rejected the update' }, 502);
    }
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: 'Could not update the sheet. Try again.' }, 502);
  }
};
