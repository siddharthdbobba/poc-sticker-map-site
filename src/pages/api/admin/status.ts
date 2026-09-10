/**
 * POST /api/admin/status  { id, status } → { ok }
 *
 * The moderation verdict. Each one now means something concrete rather than a
 * cell edit, because the queue lives in KV and the public sheet only ever holds
 * approved rows (see src/lib/pending.ts for why):
 *
 *   approve → append the row to the Google Sheet as "active"; drop the queue
 *             entry. This is the ONLY path that makes a submission public.
 *   reject  → drop the queue entry AND delete the photo from R2. A rejected
 *             submission should not keep a live URL on our domain.
 *   defer   → keep it queued, flagged so it sorts last. Still not public.
 *
 * Publishing takes two Apps Script calls: `appendRow` (which always writes
 * status "pending") followed by `setStatus` to flip it to "active". That is
 * deliberate — it works against the Apps Script deployment that is live today,
 * with no redeploy needed. The row is briefly "pending" in the sheet between the
 * two calls, which is harmless: it is a row we have just decided to publish, and
 * "pending" hides it rather than exposing it.
 *
 * Runs on the Worker (prerender = false) for SESSION KV + SHEET_WEBHOOK_*.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthenticated, json, originAllowed } from '../../../lib/admin-auth';
import { deletePending, getPending, putPending } from '../../../lib/pending';

export const prerender = false;

/** Rows as the Apps Script `listPending` action reports them. */
interface SheetPendingRow {
  row?: number;
  name: string;
  latitude: string;
}

type Verdict = 'active' | 'rejected' | 'review';
const ALLOWED: Verdict[] = ['active', 'rejected', 'review'];

/** One JSON call to the Apps Script web app, with its "200 means nothing" trap
 *  handled: it answers 200 even when it rejects the token, so the body's `ok`
 *  flag is the real result. */
async function callSheet(body: Record<string, unknown>): Promise<{ ok: boolean; row?: number }> {
  const res = await fetch(env.SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: env.SHEET_WEBHOOK_TOKEN, ...body }),
  });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; row?: number };
    return { ok: res.ok && parsed.ok === true, row: parsed.row };
  } catch {
    return { ok: false };
  }
}

/** As callSheet, but hands back the `pending` list for the row-number fallback. */
async function callSheetRaw(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; pending?: SheetPendingRow[] }> {
  try {
    const res = await fetch(env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: env.SHEET_WEBHOOK_TOKEN, ...body }),
    });
    const parsed = JSON.parse(await res.text()) as { ok?: boolean; pending?: SheetPendingRow[] };
    return { ok: res.ok && parsed.ok === true, pending: parsed.pending };
  } catch {
    return { ok: false };
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!originAllowed(request)) return json({ ok: false, error: 'forbidden' }, 403);
  if (!(await isAuthenticated(request, env.SESSION))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let id = '';
  let status = '';
  try {
    const body = (await request.json()) as { id?: unknown; status?: unknown };
    id = typeof body.id === 'string' ? body.id : '';
    status = typeof body.status === 'string' ? body.status : '';
  } catch {
    return json({ ok: false, error: 'bad request' }, 400);
  }

  if (!ALLOWED.includes(status as Verdict)) return json({ ok: false, error: 'bad status' }, 400);
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  const item = await getPending(env.SESSION, id);
  if (!item) {
    // Already moderated, or a stale queue in another officer's browser tab.
    return json({ ok: false, error: 'That submission is no longer in the queue.' }, 409);
  }

  // ── Defer: stays queued, sorts last. Nothing leaves the Worker. ──────────
  if (status === 'review') {
    await putPending(env.SESSION, { ...item, deferred: true });
    return json({ ok: true });
  }

  // ── Reject: drop it, and take the photo down with it. ────────────────────
  if (status === 'rejected') {
    if (item.photoKey) {
      // Best-effort: a failed object delete must not strand the entry in the
      // queue, or the officer can never clear it.
      try {
        await env.PHOTOS.delete(item.photoKey);
      } catch {
        // Intentionally ignored; the queue entry still goes.
      }
    }
    await deletePending(env.SESSION, id);
    return json({ ok: true });
  }

  // ── Approve: this is the moment it becomes public. ───────────────────────
  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_TOKEN) {
    return json({ ok: false, error: 'Publishing is not configured yet.' }, 503);
  }

  try {
    const appended = await callSheet({
      name: item.name,
      latitude: item.latitude,
      longitude: item.longitude,
      date: item.date,
      description: item.description,
      photo_url: item.photoUrl,
      placed_by: item.placedBy,
    });
    if (!appended.ok) throw new Error('append rejected');

    // Flip the freshly appended row to "active". Identify it by photo_url when
    // there is one — unique, and stable if rows move underneath us.
    //
    // A photo-less row has no such handle, so it needs a row number. The current
    // Code.gs returns one from the append; an older deployment does not, and
    // rather than require a redeploy the fallback asks `listPending` which rows
    // are still pending and takes the last match. Both paths re-check the row is
    // pending before writing, so neither can clobber an already-moderated row.
    let rowNumber = appended.row;
    if (!item.photoUrl && rowNumber === undefined) {
      const queue = await callSheetRaw({ action: 'listPending' });
      const rows = (queue.pending ?? []).filter(
        (r) => r.name === item.name && String(r.latitude) === String(item.latitude),
      );
      rowNumber = rows.length > 0 ? rows[rows.length - 1].row : undefined;
    }

    const flipped = item.photoUrl
      ? await callSheet({ action: 'setStatus', photo_url: item.photoUrl, status: 'active' })
      : rowNumber !== undefined
        ? await callSheet({ action: 'setStatus', row: rowNumber, status: 'active' })
        : { ok: false };

    if (!flipped.ok) {
      // The row is in the sheet but still reads "pending", so it is not on the
      // map. Keep the queue entry so the officer can retry rather than losing
      // track of it, and say plainly what happened.
      return json(
        {
          ok: false,
          error:
            'Added to the sheet but could not mark it active — check the Status ' +
            'column dropdown allows "active", then set it by hand.',
        },
        502,
      );
    }
  } catch {
    return json({ ok: false, error: 'Could not publish to the sheet. Try again.' }, 502);
  }

  await deletePending(env.SESSION, id);
  return json({ ok: true });
};
