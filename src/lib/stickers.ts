/**
 * stickers.ts
 *
 * Types + CSV parsing for the sticker map.
 * The data is a public Google Sheet published as CSV — fetched client-side
 * by StickerMapApp (see components/StickerMapApp.tsx), so there is no server
 * dependency and no secret. This module is pure (no fetch, no env).
 *
 * Expected sheet columns (row 1 = headers, exact names matter):
 *   name | latitude | longitude | date | description | photo_url | placed_by
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
}

export function parseCSV(csv: string): StickerLocation[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) =>
    h.trim().toLowerCase().replace(/\s+/g, '_')
  );

  return lines
    .slice(1)
    .map((line, index) => {
      const values = parseCSVLine(line);
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
      };
    })
    // Drop rows with invalid coordinates
    .filter((loc) => !isNaN(loc.latitude) && !isNaN(loc.longitude));
}

/** Handles quoted fields (e.g. descriptions with commas) */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
