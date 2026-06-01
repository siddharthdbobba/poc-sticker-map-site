/**
 * POC Sticker Map — submission receiver (Google Apps Script web app).
 *
 * Bound to the sticker-map spreadsheet. Receives a JSON POST from the site's
 * /api/submit Worker and appends one row to the data tab with status="pending".
 * The map hides pending rows; you approve a sighting by changing its "status"
 * cell to "active" (no row moving, no second tab).
 *
 * SETUP
 *  1. In the spreadsheet: Extensions → Apps Script. Paste this file.
 *  2. Set TOKEN below to a long random string.
 *  3. Add a "status" column to the data tab's header row, so it reads:
 *       name | latitude | longitude | date | description | photo_url | placed_by | status
 *     (Leave existing rows' status blank — blank counts as active/visible.)
 *  4. Deploy → New deployment → type "Web app" →
 *       Execute as: Me   |   Who has access: Anyone
 *     Copy the resulting ".../exec" URL.
 *  5. On the Worker, set the two secrets:
 *       wrangler secret put SHEET_WEBHOOK_URL    → paste the /exec URL
 *       wrangler secret put SHEET_WEBHOOK_TOKEN  → paste the SAME value as TOKEN
 */

const TOKEN = 'CHANGE_ME_to_a_long_random_string'; // must equal SHEET_WEBHOOK_TOKEN
// Tab the map reads (the published gid=0 tab). Leave '' to use the first tab.
const SHEET_NAME = '';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) {
      return jsonOut({ ok: false, error: 'forbidden' });
    }

    const ss = SpreadsheetApp.getActive();
    const sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
    if (!sheet) {
      return jsonOut({ ok: false, error: 'target sheet not found' });
    }

    // Values keyed by normalized header name (matches src/lib/stickers.ts).
    // New rows are always "pending"; the submitter cannot self-approve.
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

    // Match columns by header name so order doesn't matter. A "status" column
    // must exist (step 3) for moderation to take effect.
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
    sheet.appendRow(headers.map((h) => (h in values ? values[h] : '')));

    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
