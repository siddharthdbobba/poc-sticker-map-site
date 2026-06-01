/**
 * POC Sticker Map — submission receiver (Google Apps Script web app).
 *
 * Bound to the sticker-map spreadsheet. Receives a JSON POST from the site's
 * /api/submit Worker and appends one row to the "Pending" tab. The map only
 * reads the Live tab (gid=0); you approve a sighting by moving its row from
 * Pending → Live.
 *
 * SETUP
 *  1. In the spreadsheet: Extensions → Apps Script. Paste this file.
 *  2. Set TOKEN below to a long random string.
 *  3. Make sure a tab named exactly "Pending" exists with the header row:
 *       name | latitude | longitude | date | description | photo_url | placed_by
 *  4. Deploy → New deployment → type "Web app" →
 *       Execute as: Me   |   Who has access: Anyone
 *     Copy the resulting ".../exec" URL.
 *  5. On the Worker, set the two secrets:
 *       wrangler secret put SHEET_WEBHOOK_URL    → paste the /exec URL
 *       wrangler secret put SHEET_WEBHOOK_TOKEN  → paste the SAME value as TOKEN
 */

const TOKEN = 'CHANGE_ME_to_a_long_random_string'; // must equal SHEET_WEBHOOK_TOKEN
const PENDING_SHEET = 'Pending';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) {
      return jsonOut({ ok: false, error: 'forbidden' });
    }
    const sheet = SpreadsheetApp.getActive().getSheetByName(PENDING_SHEET);
    if (!sheet) {
      return jsonOut({ ok: false, error: 'Pending sheet not found' });
    }
    // Column order must match the header row (and src/lib/stickers.ts).
    sheet.appendRow([
      body.name || '',
      body.latitude,
      body.longitude,
      body.date || '',
      body.description || '',
      body.photo_url || '',
      body.placed_by || '',
    ]);
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
