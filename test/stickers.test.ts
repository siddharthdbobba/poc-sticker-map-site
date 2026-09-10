/**
 * Tests for the CSV parser — the piece of this codebase where a quiet bug is
 * most expensive, because its output decides what the public map shows and,
 * through the `status` column, what moderation hides.
 *
 * Run with `npm test` (node:test, no framework). These are the first automated
 * tests in the project; the parser earned them by silently publishing pending
 * submissions whose description contained a line break.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, parseCSVRows } from '../src/lib/stickers.ts';

const HEADER = 'name,latitude,longitude,date,description,photo_url,placed_by,status';

test('parses a plain row', () => {
  const [loc] = parseCSV(`${HEADER}\nHalf Dome,37.745,-119.533,2026-06-01,On the sign,,Sid,active`);
  assert.equal(loc.name, 'Half Dome');
  assert.equal(loc.latitude, 37.745);
  assert.equal(loc.longitude, -119.533);
  assert.equal(loc.placedBy, 'Sid');
  assert.equal(loc.status, 'active');
});

test('a quoted description containing a comma does not shift the later columns', () => {
  const [loc] = parseCSV(
    `${HEADER}\nTrailhead,40.1,-86.9,2026-01-01,"On the sign, second post",,Sid,active`,
  );
  assert.equal(loc.description, 'On the sign, second post');
  assert.equal(loc.placedBy, 'Sid');
  assert.equal(loc.status, 'active');
});

// The regression that motivated the rewrite. Splitting on newlines before
// honouring quotes tore this row in two, dropping `status` — and a blank status
// reads as visible, so the pending row published itself.
test('a quoted description containing a NEWLINE keeps the row intact', () => {
  const [loc] = parseCSV(
    `${HEADER}\nTrailhead,40.1,-86.9,2026-01-01,"line one\nline two",,Sid,active`,
  );
  assert.equal(loc.description, 'line one\nline two');
  assert.equal(loc.placedBy, 'Sid');
  assert.equal(loc.status, 'active');
});

test('a PENDING row with a multi-line description stays hidden', () => {
  const locs = parseCSV(
    `${HEADER}\nNot Approved,40.1,-86.9,2026-01-01,"line one\nline two",,Sid,pending`,
  );
  assert.deepEqual(locs, [], 'a pending submission must never reach the map');
});

test('rejected and review rows stay hidden; blank status stays visible', () => {
  const locs = parseCSV(
    `${HEADER}\n` +
      'A,1,1,,,,,rejected\n' +
      'B,2,2,,,,,review\n' +
      'C,3,3,,,,,pending\n' +
      'D,4,4,,,,,\n' +
      'E,5,5,,,,,ACTIVE\n',
  );
  assert.deepEqual(locs.map((l) => l.name), ['D', 'E']);
});

test('a doubled quote is one literal quote, not a dropped one', () => {
  const [loc] = parseCSV(
    `${HEADER}\nQuoted,40.1,-86.9,2026-01-01,"he said ""hi"", then left",,Sid,active`,
  );
  assert.equal(loc.description, 'he said "hi", then left');
  assert.equal(loc.status, 'active');
});

test('CRLF line endings do not leave a stray carriage return on the last field', () => {
  const [loc] = parseCSV(`${HEADER}\r\nA,1,2,,,,,active\r\n`);
  assert.equal(loc.status, 'active');
});

test('rows with unparseable coordinates are dropped', () => {
  const locs = parseCSV(
    `${HEADER}\n` + 'NoCoords,,,,,,,active\n' + 'Bad,north,west,,,,,active\n' + 'Good,1,2,,,,,active\n',
  );
  assert.deepEqual(locs.map((l) => l.name), ['Good']);
});

// Codex found these three: every field the parser cannot locate comes back as
// '', including `status` — and a blank status reads as visible. So a row whose
// shape is not understood used to default to *published*. The structural check
// exists to make that fall the other way.
test('a row with an unterminated quote is dropped, not published', () => {
  const locs = parseCSV(`${HEADER}\nSneak,1,2,,abc"unterminated,,Sid,pending`);
  assert.deepEqual(locs, []);
});

test('a stray unquoted comma cannot shift a pending row into visibility', () => {
  const locs = parseCSV(`${HEADER}\nSneak,1,2,,a,b,extra,,Sid,pending`);
  assert.deepEqual(locs, []);
});

test('a truncated row is dropped rather than treated as blank-status', () => {
  const locs = parseCSV(`${HEADER}\nSecret,1,2`);
  assert.deepEqual(locs, []);
});

test('a well-formed row with every column present still passes', () => {
  const locs = parseCSV(
    `${HEADER}\n` +
      'Fine,40.1,-86.9,2026-01-01,ok,,Sid,active\n' +
      'Legacy,41.1,-87.9,2026-01-02,ok,,Sid,\n',
  );
  assert.deepEqual(locs.map((l) => l.name), ['Fine', 'Legacy']);
});

test('an empty or header-only document yields no locations', () => {
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseCSV(HEADER), []);
});

test('a trailing newline does not produce a blank row', () => {
  assert.equal(parseCSVRows('a,b\n1,2\n').length, 2);
});

test('headers are matched by name, not position', () => {
  const [loc] = parseCSV('Status,Longitude,Latitude,Name\nactive,-86.9,40.1,Flipped');
  assert.equal(loc.name, 'Flipped');
  assert.equal(loc.latitude, 40.1);
  assert.equal(loc.longitude, -86.9);
});
