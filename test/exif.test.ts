/**
 * Tests for the hand-rolled EXIF reader.
 *
 * The reader is fed arbitrary files chosen by anonymous submitters, so the
 * cases that matter are the hostile and the malformed ones — a real geotagged
 * photo is the easy path and is already verified by hand against JPEG and HEIC
 * originals. What is tested here instead: that a bad file yields nothing rather
 * than throwing, and that an ambiguous file yields nothing rather than a
 * confident wrong answer.
 *
 * The GPS tests build a minimal TIFF by hand rather than checking in binary
 * fixtures, so the exact bytes under test are visible in the diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPhotoMeta } from '../src/lib/exif.ts';

// EXIF GPS tags. Entries within an IFD must be in ascending tag order.
const TAG_GPS_IFD = 0x8825;

/**
 * Build a JPEG whose APP1 segment carries a GPS IFD, little-endian.
 * `latRef`/`lonRef` are the hemisphere letters; pass null to omit the tag
 * entirely, which is the case the reader must refuse to guess at.
 */
function jpegWithGps(opts: {
  lat: [number, number, number];
  lon: [number, number, number];
  latRef: string | null;
  lonRef: string | null;
}): Uint8Array {
  const refs = [opts.latRef, opts.lonRef];
  const entryCount = 2 + refs.filter((r) => r !== null).length;

  const gpsStart = 26;
  const entriesEnd = gpsStart + 2 + entryCount * 12;
  const dataStart = entriesEnd + 4; // after the "next IFD" pointer
  const latDataOff = dataStart;
  const lonDataOff = dataStart + 24;
  const tiffLength = lonDataOff + 24;

  const tiff = new Uint8Array(tiffLength);
  const view = new DataView(tiff.buffer);

  tiff[0] = 0x49; tiff[1] = 0x49; // "II" — little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true); // IFD0 at offset 8

  // IFD0: one entry, the pointer to the GPS IFD.
  view.setUint16(8, 1, true);
  view.setUint16(10, TAG_GPS_IFD, true);
  view.setUint16(12, 4, true); // LONG
  view.setUint32(14, 1, true);
  view.setUint32(18, gpsStart, true);
  view.setUint32(22, 0, true); // no next IFD

  view.setUint16(gpsStart, entryCount, true);
  let p = gpsStart + 2;
  const entry = (tag: number, type: number, count: number, write: (at: number) => void) => {
    view.setUint16(p, tag, true);
    view.setUint16(p + 2, type, true);
    view.setUint32(p + 4, count, true);
    write(p + 8);
    p += 12;
  };

  if (opts.latRef !== null) {
    entry(0x0001, 2, 2, (at) => { // ASCII, inline (≤4 bytes)
      tiff[at] = opts.latRef!.charCodeAt(0);
      tiff[at + 1] = 0;
    });
  }
  entry(0x0002, 5, 3, (at) => view.setUint32(at, latDataOff, true)); // RATIONAL[3]
  if (opts.lonRef !== null) {
    entry(0x0003, 2, 2, (at) => {
      tiff[at] = opts.lonRef!.charCodeAt(0);
      tiff[at + 1] = 0;
    });
  }
  entry(0x0004, 5, 3, (at) => view.setUint32(at, lonDataOff, true));

  view.setUint32(p, 0, true); // no next IFD

  const writeDms = (off: number, dms: [number, number, number]) => {
    dms.forEach((v, i) => {
      // Encode with a denominator of 100 so minutes/seconds keep precision.
      view.setUint32(off + i * 8, Math.round(v * 100), true);
      view.setUint32(off + i * 8 + 4, 100, true);
    });
  };
  writeDms(latDataOff, opts.lat);
  writeDms(lonDataOff, opts.lon);

  // Wrap: SOI + APP1(len, "Exif\0\0", tiff)
  const app1Len = 2 + 6 + tiff.length;
  const out = new Uint8Array(2 + 2 + app1Len);
  out.set([0xff, 0xd8, 0xff, 0xe1], 0);
  out[4] = (app1Len >> 8) & 0xff;
  out[5] = app1Len & 0xff;
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6);
  out.set(tiff, 12);
  return out;
}

const asFile = (bytes: Uint8Array) => new File([bytes as unknown as BlobPart], 'photo.jpg');

test('N/W refs produce the correct signs', async () => {
  const meta = await readPhotoMeta(
    asFile(jpegWithGps({ lat: [40, 30, 0], lon: [86, 55, 0], latRef: 'N', lonRef: 'W' })),
  );
  assert.ok(Math.abs((meta.latitude ?? 0) - 40.5) < 1e-6);
  assert.ok(Math.abs((meta.longitude ?? 0) + 86.916666) < 1e-4);
});

test('S/E refs produce the opposite signs', async () => {
  const meta = await readPhotoMeta(
    asFile(jpegWithGps({ lat: [33, 51, 0], lon: [151, 12, 0], latRef: 'S', lonRef: 'E' })),
  );
  assert.ok((meta.latitude ?? 0) < 0, 'S must be negative');
  assert.ok((meta.longitude ?? 0) > 0, 'E must be positive');
});

// The sign lives in the ref tag, and the coordinate values are unsigned. With no
// ref there is no hemisphere, and guessing "north/east" would place the point on
// the wrong side of the planet while looking perfectly plausible — the same
// failure that put two Alaska sightings in the Russian Far East.
test('a missing hemisphere ref yields NO fix rather than a guess', async () => {
  const meta = await readPhotoMeta(
    asFile(jpegWithGps({ lat: [40, 30, 0], lon: [86, 55, 0], latRef: null, lonRef: null })),
  );
  assert.equal(meta.latitude, undefined);
  assert.equal(meta.longitude, undefined);
});

test('an unrecognised hemisphere ref yields no fix', async () => {
  const meta = await readPhotoMeta(
    asFile(jpegWithGps({ lat: [40, 30, 0], lon: [86, 55, 0], latRef: 'X', lonRef: 'Q' })),
  );
  assert.equal(meta.latitude, undefined);
  assert.equal(meta.longitude, undefined);
});

test('one missing ref is enough to reject the pair', async () => {
  const meta = await readPhotoMeta(
    asFile(jpegWithGps({ lat: [40, 30, 0], lon: [86, 55, 0], latRef: 'N', lonRef: null })),
  );
  assert.equal(meta.longitude, undefined);
  assert.equal(meta.latitude, undefined, 'a half-known position is not a position');
});

test('a photo with no EXIF at all returns an empty result', async () => {
  assert.deepEqual(await readPhotoMeta(asFile(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]))), {});
  assert.deepEqual(await readPhotoMeta(asFile(new Uint8Array(0))), {});
});

test('random and truncated bytes never throw', async () => {
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(Math.random() * 400);
    const bytes = new Uint8Array(n);
    for (let j = 0; j < n; j++) bytes[j] = Math.floor(Math.random() * 256);
    // Bias towards something that looks like it might be parseable.
    bytes[0] = 0xff; bytes[1] = 0xd8;
    await readPhotoMeta(asFile(bytes)); // must resolve, not reject
  }
  const good = jpegWithGps({ lat: [40, 30, 0], lon: [86, 55, 0], latRef: 'N', lonRef: 'W' });
  for (const cut of [13, 20, 40, good.length - 5]) {
    assert.deepEqual(typeof (await readPhotoMeta(asFile(good.slice(0, cut)))), 'object');
  }
});
