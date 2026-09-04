/**
 * GET /api/admin/pending → { ok, pending: [...] }
 *
 * Proxies the Apps Script `listPending` action. The Worker holds the sheet
 * webhook token, so the browser never sees it: the admin session is what
 * authorises the call, and the token stays server-side exactly as it does for
 * /api/submit.
 *
 * Runs on the Worker (prerender = false) for SESSION KV + SHEET_WEBHOOK_*.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthenticated, json } from '../../../lib/admin-auth';

export const prerender = false;

/** One pending row as Apps Script returns it (all values arrive as strings). */
export interface PendingRow {
  row?: number;
  name: string;
  latitude: string;
  longitude: string;
  date: string;
  description: string;
  photo_url: string;
  placed_by: string;
}

export const GET: APIRoute = async ({ request }) => {
  if (!(await isAuthenticated(request, env.SESSION))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_TOKEN) {
    return json({ ok: false, error: 'Moderation is not configured yet.' }, 503);
  }

  try {
    const res = await fetch(env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: env.SHEET_WEBHOOK_TOKEN,
        action: 'listPending',
      }),
    });
    // Apps Script answers 200 even when it rejects the token, so the `ok` flag
    // in the body is the real result — same trap as /api/submit.
    const text = await res.text();
    let parsed: { ok?: boolean; pending?: PendingRow[] };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error('sheet webhook returned non-JSON');
    }
    if (!res.ok || parsed.ok !== true) {
      throw new Error(`sheet webhook rejected (${res.status})`);
    }
    return json({ ok: true, pending: parsed.pending ?? [] });
  } catch {
    return json({ ok: false, error: 'Could not load the queue. Try again.' }, 502);
  }
};
