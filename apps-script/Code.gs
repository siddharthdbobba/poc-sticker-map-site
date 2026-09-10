/**
 * POC Sticker Map — submission receiver + moderation API (Google Apps Script).
 *
 * One web app, three JSON POST actions (all require the shared token):
 *   • (no action)  — append a new sighting as status="pending"  [used by /api/submit]
 *   • listPending  — return every pending row                    [reviewer agent]
 *   • setStatus    — set one row's status, matched by photo_url  [reviewer agent]
 *
 * The map (src/lib/stickers.ts) shows rows whose status is blank or "active" and
 * HIDES "pending" / "rejected" / "review". So the reviewer maps verdicts to:
 *   approve → "active" (visible)   reject → "rejected" (hidden)   defer → "review" (hidden)
 *
 * SETUP (first time)
 *   1. Spreadsheet → Extensions → Apps Script. Paste this file.
 *   2. Project Settings (gear) → Script Properties → add SHEET_WEBHOOK_TOKEN,
 *      set to a long random string (must equal the Worker's SHEET_WEBHOOK_TOKEN
 *      secret). Do NOT put the token in this file — it lives in a public repo.
 *   3. The status column's DROPDOWN must list every status this file writes:
 *        active | pending | rejected | review
 *      The sheet uses a Table + data validation, and Tables ENFORCE the column
 *      type: setValue() THROWS on a value that isn't in the dropdown, which
 *      surfaces as a failed execution and a generic 502 from /api/admin/status.
 *      Symptom: approve works (active is listed) but defer/reject both fail.
 *   4. Header row must read (exact names):
 *        name | latitude | longitude | date | description | photo_url | placed_by | status
 *   5. Deploy → New deployment → type "Web app" →
 *        Execute as: Me   |   Who has access: Anyone
 *      Copy the ".../exec" URL. Set the Worker secrets:
 *        wrangler secret put SHEET_WEBHOOK_URL    → the /exec URL
 *        wrangler secret put SHEET_WEBHOOK_TOKEN  → the SAME value as the property
 *      The reviewer agent reuses these same two values (see its .env).
 *
 * UPDATING (after you edit this file)
 *   Deploy → Manage deployments → (the existing deployment) → ✎ Edit →
 *     Version: "New version" → Deploy.
 *   Do NOT create a *new* deployment — that mints a new /exec URL and breaks the
 *   live submit flow, whose secret still points at the old one. Same URL, new version.
 */

/**
 * The shared token, read from Script Properties — NOT from a constant in this
 * file. Why: this file is in a public git repo, so a real token pasted here
 * would be published. The previous version kept a `CHANGE_ME_…` placeholder in
 * the repo and the real value only in the deployed copy, which meant the file
 * you are reading and the code actually running had silently diverged, with no
 * way to tell them apart. A property keeps the secret out of the repo AND keeps
 * the repo copy deployable as-is.
 *
 * Set it once: Apps Script editor → Project Settings (gear) → Script Properties
 * → Add script property → name SHEET_WEBHOOK_TOKEN, value = the same string as
 * the Worker's SHEET_WEBHOOK_TOKEN secret.
 *
 * LEGACY_TOKEN is the migration path: an existing deployment that still has its
 * token inline keeps working until the property is set. Leave it empty in the
 * repo and delete this fallback once the property is in place.
 */
const LEGACY_TOKEN = ''; // deprecated — set the SHEET_WEBHOOK_TOKEN script property instead

function getToken() {
  const fromProperties = PropertiesService.getScriptProperties().getProperty(
    'SHEET_WEBHOOK_TOKEN',
  );
  return fromProperties || LEGACY_TOKEN;
}
const SHEET_NAME = ''; // '' = first tab (the published gid=0 tab the map reads)

const ALLOWED_STATUSES = ['active', 'rejected', 'review', 'pending'];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = getToken();
    // Fail closed on an unconfigured deployment: with no token set, an empty
    // body.token would otherwise match and authorise every caller.
    if (!token || body.token !== token) {
      return jsonOut({ ok: false, error: 'forbidden' });
    }

    const ss = SpreadsheetApp.getActive();
    const sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
    if (!sheet) {
      return jsonOut({ ok: false, error: 'target sheet not found' });
    }

    const action = body.action || '';
    if (action === 'listPending') {
      return jsonOut({ ok: true, pending: listPending(sheet) });
    }
    if (action === 'setStatus') {
      return jsonOut(setStatus(sheet, body));
    }
    // Reject any *named* action we don't recognize. Without this, a typo'd or
    // wrong-case action (e.g. "setstatus") would silently fall through to
    // appendRow and inject a spurious pending row — duplicating a photo_url and
    // breaking setStatus's first-match. Only the no-action /api/submit path appends.
    if (action !== '') {
      return jsonOut({ ok: false, error: 'unknown action: ' + action });
    }
    return jsonOut(appendRow(sheet, body));
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// Normalized header name -> column index. Order-independent (matches by name).
function headerIndex(sheet) {
  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));
  return { headers, idx };
}

// Append a new sighting. Always "pending" — a submitter cannot self-approve.
function appendRow(sheet, body) {
  const values = {
    name: body.name || '',
    latitude: body.latitude,
    longitude: body.longitude,
    date: body.date || '',
    description: body.description || '',
    photo_url: body.photo_url || '',
    placed_by: body.placed_by || '',
    status: 'pending',
  };
  const { headers } = headerIndex(sheet);
  sheet.appendRow(headers.map((h) => (h in values ? values[h] : '')));
  return { ok: true };
}

// Return every row whose status is exactly "pending".
//
// `row` is the 1-based sheet row. It's what lets the admin UI moderate a
// submission that has no photo: the photo is optional on the submit form, so
// photo_url — the usual identifier — can be empty. setStatus re-checks the row
// is still pending before writing, so a number that went stale between this call
// and the write fails closed instead of clobbering a moderated row.
function listPending(sheet) {
  const data = sheet.getDataRange().getValues();
  const { idx } = headerIndex(sheet);
  const cell = (row, key) => (idx[key] != null ? String(row[idx[key]] == null ? '' : row[idx[key]]).trim() : '');

  const pending = [];
  for (let r = 1; r < data.length; r++) {
    if (cell(data[r], 'status').toLowerCase() !== 'pending') continue;
    pending.push({
      row: r + 1,
      name: cell(data[r], 'name'),
      latitude: cell(data[r], 'latitude'),
      longitude: cell(data[r], 'longitude'),
      date: cell(data[r], 'date'),
      description: cell(data[r], 'description'),
      photo_url: cell(data[r], 'photo_url'),
      placed_by: cell(data[r], 'placed_by'),
    });
  }
  return pending;
}

// Set one row's status, identified by its (unique) photo_url when it has one,
// or by the row number from listPending when it does not.
//
// photo_url is preferred: matching by URL instead of row number is robust
// against rows being added or moved between the listPending call and this one.
// But the submit form makes the photo OPTIONAL, so a photo-less pending row has
// an empty photo_url and can only be addressed by number. To keep that safe, the
// row-number path refuses to write unless the row is *still* pending — a stale
// number then fails closed rather than overwriting an already-moderated row.
function setStatus(sheet, body) {
  const status = String(body.status || '').trim().toLowerCase();
  if (ALLOWED_STATUSES.indexOf(status) === -1) {
    return { ok: false, error: 'bad status: ' + status };
  }
  const target = String(body.photo_url || '').trim();
  const row = Number(body.row);
  const hasRow = Number.isInteger(row) && row > 1;
  if (!target && !hasRow) {
    return { ok: false, error: 'photo_url or row required' };
  }

  const data = sheet.getDataRange().getValues();
  const { idx } = headerIndex(sheet);
  if (idx['status'] == null) {
    return { ok: false, error: 'missing status column' };
  }

  if (target) {
    if (idx['photo_url'] == null) {
      return { ok: false, error: 'missing photo_url column' };
    }
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][idx['photo_url']] == null ? '' : data[r][idx['photo_url']]).trim() === target) {
        sheet.getRange(r + 1, idx['status'] + 1).setValue(status);
        return { ok: true, row: r + 1, status: status };
      }
    }
    return { ok: false, error: 'photo_url not found' };
  }

  // Row-number path (photo-less submissions only).
  if (row > data.length) {
    return { ok: false, error: 'row out of range' };
  }
  const current = String(data[row - 1][idx['status']] == null ? '' : data[row - 1][idx['status']])
    .trim()
    .toLowerCase();
  if (current !== 'pending') {
    return { ok: false, error: 'row is no longer pending (now: ' + (current || 'blank') + ')' };
  }
  sheet.getRange(row, idx['status'] + 1).setValue(status);
  return { ok: true, row: row, status: status };
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
