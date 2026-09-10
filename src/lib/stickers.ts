/**
 * stickers.ts
 *
 * Types + CSV parsing for the sticker map.
 * The data is a public Google Sheet published as CSV — fetched client-side
 * by StickerMapApp (see components/StickerMapApp.tsx), so there is no server
 * dependency and no secret. This module is pure (no fetch, no env).
 *
 * Expected sheet columns (row 1 = headers, exact names matter):
 *   name | latitude | longitude | date | description | photo_url | placed_by | status
 *
 * `status` drives moderation: rows submitted via /submit are appended as
 * "pending" and hidden from the map. The reviewer (apps-script + the
 * examples/submission-reviewer-agent) sets it to "active" (visible), "rejected",
 * or "review" (the latter two stay hidden). Rows with no/empty status are
 * treated as active (so pre-existing data shows).
 */

export interface StickerLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  date: string;
  description: string;
  photoUrl: string;
  placedBy: string;
  status: string;
}

export function parseCSV(csv: string): StickerLocation[] {
  const rows = parseCSVRows(csv);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  return rows
    .slice(1)
    .map((values, index) => {
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = values[i]?.trim() ?? '';
      });

      return {
        id: String(index + 1),
        name: row['name'] || 'Unknown Location',
        latitude: parseFloat(row['latitude']),
        longitude: parseFloat(row['longitude']),
        date: row['date'] || '',
        description: row['description'] || '',
        photoUrl: row['photo_url'] || '',
        placedBy: row['placed_by'] || '',
        status: row['status'] || '',
      };
    })
    // Drop rows with invalid coordinates, and hide moderated-out submissions.
    // Hidden statuses: "pending" (awaiting review), "rejected" (declined), and
    // "review" (deferred to a human). Empty/"active"/anything else stays visible,
    // so existing rows without a status still show.
    .filter((loc) => {
      const status = loc.status.trim().toLowerCase();
      return (
        !isNaN(loc.latitude) &&
        !isNaN(loc.longitude) &&
        status !== 'pending' &&
        status !== 'rejected' &&
        status !== 'review'
      );
    });
}

/**
 * Split a whole CSV document into rows of fields.
 *
 * This is a single character-wise pass rather than `split('\n')` then a
 * per-line field split, and the difference is not cosmetic. A quoted field may
 * legally contain a line break — and does, constantly, because the /submit
 * description box is a textarea and people press Enter in it. Splitting on
 * newlines first tears such a row in half, which shifted every later field left
 * by one: the description was truncated, `placed_by` was lost, and — the part
 * that mattered — `status` was lost too. A blank status reads as *visible*, so a
 * PENDING submission with a two-line description published itself on the map,
 * with no review. Any parser here must therefore honour quotes before newlines.
 *
 * Also handles the other half of RFC 4180 that the old splitter dropped: a
 * doubled quote inside a quoted field ("" ) is one literal quote character, not
 * a pair of delimiters that cancel out and vanish.
 *
 * CRLF is normalised to LF so a sheet exported with Windows line endings does
 * not leave a stray \r on the last field of every row (which would have made
 * `status` "active\r" — not equal to "active", though harmlessly so here).
 */
export function parseCSVRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote is an escaped literal quote; a lone one ends the field.
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Outside quotes a newline ends the row. Swallow the LF of a CRLF pair.
      if (ch === '\r' && csv[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  // Whatever is still buffered is the last row, unless the file ended on a
  // newline (in which case there is nothing left and we must not add a blank).
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // A trailing blank line yields a single empty field — not a real row.
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}
