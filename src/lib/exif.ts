/**
 * exif.ts
 *
 * Minimal EXIF reader: pulls the GPS fix and the capture date out of a photo so
 * /submit can pre-fill "Where is it?" instead of making the submitter re-find a
 * place they already stood in.
 *
 * Pure like src/lib/stickers.ts — it takes bytes and returns numbers. No fetch,
 * no env. Turning the coordinates into a place *name* is a network call, so that
 * stays in SubmitForm (Nominatim reverse geocode).
 *
 * Two things make this trickier than it looks:
 *
 * 1. Order matters. The submit form re-encodes the photo through a <canvas>
 *    before upload, and canvas output carries NO EXIF — the GPS is destroyed by
 *    the downscale. So this must run on the ORIGINAL File, before processImage.
 *
 * 2. Container variety. EXIF is a TIFF block that lives in different wrappers:
 *    a JPEG APP1 segment, an HEIC `Exif` item, a WebP `EXIF` chunk. Rather than
 *    parse three containers, we walk JPEG segments properly (cheap, and it's the
 *    common case) and otherwise scan the file head for every plausible start of
 *    a TIFF block, trying them in turn (see findTiffOffsets — HEIC plants a
 *    decoy). The scan is bounded and every offset is range-checked, so a bad
 *    guess yields an empty result, never a throw.
 *
 * No dependency: an EXIF library would be ~15 KB on a page whose whole job is
 * one form, and we need exactly four tags.
 */

/** How much of the file head to search. EXIF sits near the front in every
 *  container we accept; 512 KB is generous for HEIC's meta box and still a
 *  cheap slice of a 5 MB phone original. */
const SCAN_BYTES = 512 * 1024;

/** Cap on candidate TIFF offsets tried per photo, so a pathological file can't
 *  turn the scan into a long parse loop. Real photos produce one or two. */
const MAX_CANDIDATES = 8;

export interface PhotoMeta {
  /** Decimal degrees, signed (S/W negative). Present only when the photo has a GPS fix. */
  latitude?: number;
  longitude?: number;
  /** Capture date as YYYY-MM-DD, from DateTimeOriginal. */
  takenOn?: string;
}

// EXIF tag ids we care about.
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;

// Bytes per component, indexed by EXIF type id (1..12). 0 = unknown type.
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/**
 * Read GPS + capture date from a photo. Resolves to an empty object for any
 * photo without EXIF (a screenshot, a PNG, a location-stripped export) — a
 * missing fix is the normal case, never an error.
 */
export async function readPhotoMeta(file: File): Promise<PhotoMeta> {
  try {
    const buf = await file.slice(0, SCAN_BYTES).arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    for (const tiff of findTiffOffsets(bytes)) {
      const meta = parseTiff(view, tiff, bytes.length);
      // A candidate that parses but carries neither tag is a decoy (or an EXIF
      // block with nothing we want) — keep looking.
      if (meta.latitude !== undefined || meta.takenOn) return meta;
    }
    return {};
  } catch {
    // A malformed or truncated photo must never block the upload — the
    // submitter can always set the location by hand.
    return {};
  }
}

/**
 * Every plausible start of the TIFF block that holds the EXIF IFDs, best guess
 * first. A *list* rather than a single answer because the obvious marker lies:
 * an HEIC file declares its EXIF item in an `infe` box that contains the literal
 * bytes `Exif\0\0` a good 10 KB before the real payload, so the first hit is a
 * decoy. The caller parses candidates in order and keeps the first that yields
 * actual EXIF, which costs a few failed header checks and gets HEIC right.
 */
function findTiffOffsets(b: Uint8Array): number[] {
  // JPEG: FF D8, then a chain of FF <marker> <2-byte big-endian length> segments.
  // The segment walk is exact, so a hit here needs no alternatives.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 4 < b.length) {
      if (b[p] !== 0xff) break; // out of sync — fall through to the scan
      const marker = b[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2; // standalone marker, no length
        continue;
      }
      // SOS (FF DA) starts the entropy-coded image data; no more metadata after it.
      if (marker === 0xda) break;
      const len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2) break;
      if (marker === 0xe1 && hasExifMarker(b, p + 4)) return [p + 10]; // APP1 + "Exif\0\0"
      p += 2 + len;
    }
  }

  // HEIC / WebP / anything else: scan the head. Two passes, because HEIC writers
  // vary — some prefix the payload with `Exif\0\0`, others hand over a bare TIFF
  // header — and the marker pass also catches the `infe` decoy described above.
  const marked: number[] = [];
  const bare: number[] = [];
  for (let i = 0; i + 8 < b.length && marked.length + bare.length < MAX_CANDIDATES; i++) {
    if (b[i] === 0x45 && hasExifMarker(b, i)) {
      marked.push(i + 6);
    } else if (
      // "II*\0" (little-endian) or "MM\0*" (big-endian) — the TIFF header itself.
      (b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0x00) ||
      (b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0x00 && b[i + 3] === 0x2a)
    ) {
      bare.push(i);
    }
  }
  return [...marked, ...bare];
}

/** True when `Exif\0\0` starts at `i`. */
function hasExifMarker(b: Uint8Array, i: number): boolean {
  return (
    i + 6 <= b.length &&
    b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 &&
    b[i + 4] === 0x00 && b[i + 5] === 0x00
  );
}

/**
 * Walk IFD0 → the Exif and GPS sub-IFDs. Every offset in a TIFF block is
 * relative to the block's own start, which is why `tiff` is threaded through.
 */
function parseTiff(view: DataView, tiff: number, size: number): PhotoMeta {
  if (tiff + 8 > size) return {};
  const order = view.getUint16(tiff, false);
  if (order !== 0x4949 && order !== 0x4d4d) return {}; // not "II" or "MM"
  const le = order === 0x4949;
  if (view.getUint16(tiff + 2, le) !== 42) return {}; // TIFF magic

  const ifd0 = tiff + view.getUint32(tiff + 4, le);
  const entries = readIfd(view, tiff, ifd0, le, size);
  const meta: PhotoMeta = {};

  const exifIfd = entries.get(TAG_EXIF_IFD);
  if (exifIfd) {
    const exif = readIfd(view, tiff, tiff + num(view, exifIfd, le), le, size);
    const raw = ascii(view, exif.get(TAG_DATE_TIME_ORIGINAL), size);
    // EXIF spells dates "2026:09:08 14:03:11" — colons in the date part too.
    const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2})/);
    if (m) meta.takenOn = `${m[1]}-${m[2]}-${m[3]}`;
  }

  const gpsIfd = entries.get(TAG_GPS_IFD);
  if (gpsIfd) {
    const gps = readIfd(view, tiff, tiff + num(view, gpsIfd, le), le, size);
    const lat = dms(view, gps.get(TAG_GPS_LAT), le, size);
    const lon = dms(view, gps.get(TAG_GPS_LON), le, size);
    const latRef = ascii(view, gps.get(TAG_GPS_LAT_REF), size);
    const lonRef = ascii(view, gps.get(TAG_GPS_LON_REF), size);
    if (lat !== null && lon !== null) {
      const latitude = latRef?.toUpperCase() === 'S' ? -lat : lat;
      const longitude = lonRef?.toUpperCase() === 'W' ? -lon : lon;
      // A photo with GPS hardware but no fix writes 0/0 — the null island, not
      // a place anyone put a sticker. Treat it as "no location".
      if (
        Number.isFinite(latitude) && Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 &&
        !(latitude === 0 && longitude === 0)
      ) {
        meta.latitude = latitude;
        meta.longitude = longitude;
      }
    }
  }

  return meta;
}

/** One directory entry, kept as its raw parts so the reader picks the type. */
interface Entry {
  type: number;
  count: number;
  /** Absolute offset of the value bytes (already resolved inline-vs-pointer). */
  offset: number;
}

/** Read an IFD into a tag → entry map. Out-of-range directories read as empty. */
function readIfd(
  view: DataView,
  tiff: number,
  ifd: number,
  le: boolean,
  size: number,
): Map<number, Entry> {
  const out = new Map<number, Entry>();
  if (ifd < tiff || ifd + 2 > size) return out;
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const p = ifd + 2 + i * 12;
    if (p + 12 > size) break;
    const tag = view.getUint16(p, le);
    const type = view.getUint16(p + 2, le);
    const n = view.getUint32(p + 4, le);
    const bytes = (TYPE_SIZES[type] ?? 0) * n;
    if (bytes === 0) continue;
    // ≤4 bytes are stored in the entry itself; anything larger is a pointer
    // relative to the TIFF header.
    const offset = bytes <= 4 ? p + 8 : tiff + view.getUint32(p + 8, le);
    if (offset < 0 || offset + bytes > size) continue;
    out.set(tag, { type, count: n, offset });
  }
  return out;
}

/** Value of a SHORT/LONG entry (used for the sub-IFD pointers). */
function num(view: DataView, e: Entry, le: boolean): number {
  return e.type === 3 ? view.getUint16(e.offset, le) : view.getUint32(e.offset, le);
}

/** ASCII entry, trimmed of its NUL terminator. */
function ascii(view: DataView, e: Entry | undefined, size: number): string | null {
  if (!e || e.type !== 2 || e.offset + e.count > size) return null;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const c = view.getUint8(e.offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || null;
}

/**
 * GPS coordinates are three RATIONALs — degrees, minutes, seconds — each a pair
 * of 32-bit ints. Fold them into decimal degrees (unsigned; the N/S/E/W ref tag
 * supplies the sign).
 */
function dms(view: DataView, e: Entry | undefined, le: boolean, size: number): number | null {
  if (!e || e.type !== 5 || e.count < 3 || e.offset + 24 > size) return null;
  let deg = 0;
  for (let i = 0; i < 3; i++) {
    const numerator = view.getUint32(e.offset + i * 8, le);
    const denominator = view.getUint32(e.offset + i * 8 + 4, le);
    if (denominator === 0) return null;
    deg += numerator / denominator / 60 ** i;
  }
  return Number.isFinite(deg) ? deg : null;
}
