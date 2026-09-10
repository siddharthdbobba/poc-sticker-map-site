/**
 * GET /api/admin/pending → { ok, pending: [...] }
 *
 * The moderation queue, read from KV (src/lib/pending.ts).
 *
 * It used to proxy the Apps Script `listPending` action, back when submissions
 * were written straight into the Google Sheet as `status = "pending"`. That
 * sheet is shared "anyone with the link can view", so those rows were public
 * the moment they were created — the queue is in KV now, where only the Worker
 * can read it, and the sheet only ever receives approved rows.
 *
 * Runs on the Worker (prerender = false) for the SESSION KV binding.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthenticated, json } from '../../../lib/admin-auth';
import { listPending, type PendingSubmission } from '../../../lib/pending';

export const prerender = false;

export type { PendingSubmission };

export const GET: APIRoute = async ({ request }) => {
  if (!(await isAuthenticated(request, env.SESSION))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SESSION) {
    return json({ ok: false, error: 'Moderation is not configured yet.' }, 503);
  }

  try {
    return json({ ok: true, pending: await listPending(env.SESSION) });
  } catch {
    return json({ ok: false, error: 'Could not load the queue. Try again.' }, 502);
  }
};
