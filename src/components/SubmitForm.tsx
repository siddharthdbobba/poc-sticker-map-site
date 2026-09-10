/**
 * SubmitForm.tsx
 *
 * Client island for /submit. Lets anyone contribute a sticker sighting:
 *   - pick a photo (downscaled in-browser before upload; HEIC falls back to original)
 *     → its EXIF GPS/date pre-fill the location and date (see readPhotoMeta below)
 *   - type a place → geocoded via Nominatim (client-side, light use only)
 *   - add a date / story / their name
 * Posts multipart form-data to /api/submit, which stores the photo in R2 and
 * appends a row to the Google Sheet "Pending" tab for review.
 *
 * Styling reuses the theme tokens from global.css (no new colors).
 */

import { useEffect, useRef, useState } from 'react';
import { readPhotoMeta } from '../lib/exif';

interface GeocodeResult {
  lat: string;
  lon: string;
  display_name: string;
  place_id: number;
}

interface ChosenLocation {
  lat: number;
  lon: number;
  name: string;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

const MAX_DIM = 1600; // longest edge after downscale
const MAX_BYTES = 8 * 1024 * 1024;

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  color: 'var(--text)',
  fontSize: '0.95rem',
  fontFamily: 'inherit',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8rem',
  color: 'var(--muted)',
  marginBottom: '0.35rem',
  fontWeight: 600,
};

const fieldStyle: React.CSSProperties = { marginBottom: '1.1rem' };

const todayISO = () => new Date().toISOString().slice(0, 10);

// A decimal-degree "lat, lng" pair (comma- or space-separated) — exactly the
// shape Google Maps copies when you right-click a point and click the coords.
const COORD_PAIR_RE = /^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/;

/**
 * Parse a typed/pasted "lat, lng" decimal-degree pair, validating ranges.
 * Returns null for anything that isn't a clean coordinate pair (e.g. an
 * address), so the place search handles those instead.
 */
function parseCoords(str: string): { lat: number; lon: number } | null {
  const m = str.trim().match(COORD_PAIR_RE);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Turn a coordinate from a photo's EXIF into a human place name, so the form can
 * show "Cascade Falls Trailhead, …" rather than a bare pair of numbers. Same
 * Nominatim service as the forward search (and the same `connect-src` CSP
 * entry); `zoom=16` asks for roughly neighbourhood/POI granularity instead of a
 * full street address.
 *
 * Returns null on any failure — the coordinates are already good enough to
 * submit, so a naming miss must never cost the submitter their location.
 */
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url =
      'https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=' +
      encodeURIComponent(String(lat)) + '&lon=' + encodeURIComponent(String(lon));
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Downscale + re-encode the photo to JPEG in the browser so we don't upload a
 * 4–5 MB phone original. If the browser can't decode it (HEIC on non-Apple),
 * fall back to the original file untouched (server caps the size).
 */
async function processImage(file: File): Promise<{ blob: Blob; name: string }> {
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    } as ImageBitmapOptions);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    if (!blob) throw new Error('toBlob returned null');
    return { blob, name: 'photo.jpg' };
  } catch {
    return { blob: file, name: file.name || 'photo' };
  }
}

export default function SubmitForm() {
  const [processed, setProcessed] = useState<{ blob: Blob; name: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  // Set when the location currently in the form came from the photo's EXIF, so
  // the UI can say so and offer one click to take it back.
  const [autoLocated, setAutoLocated] = useState(false);
  const [readingExif, setReadingExif] = useState(false);

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [location, setLocation] = useState<ChosenLocation | null>(null);
  const [mode, setMode] = useState<'address' | 'coords'>('address');
  const [latInput, setLatInput] = useState('');
  const [lonInput, setLonInput] = useState('');

  const [name, setName] = useState('');
  const [placedBy, setPlacedBy] = useState('');
  const [date, setDate] = useState(todayISO());
  // Today's date is a guess, not an answer — EXIF may overwrite it. Once the
  // submitter types a date themselves it is an answer, and stays put.
  const [dateTouched, setDateTouched] = useState(false);
  const [description, setDescription] = useState('');

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  // First Submit with no photo arms this warning instead of sending; a second
  // click goes through. Cleared the moment a photo is attached.
  const [confirmNoPhoto, setConfirmNoPhoto] = useState(false);

  const previewRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Bumped on every photo choice. The reverse geocode is slow (seconds, on a
  // shared public service), so a submitter who swaps photos mid-lookup would
  // otherwise get the FIRST photo's place name written over the second photo's
  // location. Whoever finishes late checks this and stands down.
  const photoToken = useRef(0);
  // True once the submitter has set the location *themselves* (picked a search
  // result, or typed a valid coordinate pair). A photo's EXIF may fill an empty
  // form and may replace what an earlier photo guessed, but it must never
  // overwrite a person's own answer. A ref, not state: applyPhotoMeta reads this
  // after an await, where a captured state value would be a stale render's.
  const userSetLocation = useRef(false);

  // Debounced client-side geocoding (Nominatim), address mode only. Light use only.
  useEffect(() => {
    const q = query.trim();
    if (mode !== 'address' || q.length < 3 || (location && q === location.name)) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const url =
          'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
          encodeURIComponent(q);
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        const data = (await res.json()) as GeocodeResult[];
        setSuggestions(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, location, mode]);

  // Revoke the object URL when the preview changes / unmounts.
  useEffect(() => {
    previewRef.current = preview;
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [preview]);

  async function onPhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setConfirmNoPhoto(false); // they're adding a photo — drop the "no photo" warning
    if (file.size > MAX_BYTES * 3) {
      // Even the original is implausibly large; canvas resize would still help,
      // but guard against decoding something enormous.
      setError('That file is very large — please choose a photo under ~24 MB.');
      return;
    }
    setProcessing(true);
    const token = ++photoToken.current;
    // Read EXIF from the ORIGINAL file, before processImage: the canvas
    // re-encode that downscales the photo drops every metadata block with it,
    // so this is the only moment the GPS fix still exists.
    const meta = await readPhotoMeta(file);
    const result = await processImage(file);
    if (result.blob.size > MAX_BYTES) {
      setProcessing(false);
      setProcessed(null);
      setError('Photo is too large after processing (8 MB max). Try a JPG or PNG.');
      return;
    }
    setProcessed(result);
    setPreview(URL.createObjectURL(result.blob));
    setProcessing(false);
    applyPhotoMeta(meta, token);
  }

  /**
   * Pre-fill the form from a photo's EXIF. Deliberately additive: anything the
   * submitter has already answered wins, because they were there and the camera
   * only knows where it was standing. So the location is filled only when the
   * form has none, and the date only while it is still the untouched default.
   */
  async function applyPhotoMeta(meta: Awaited<ReturnType<typeof readPhotoMeta>>, token: number) {
    if (meta.takenOn && !dateTouched && meta.takenOn <= todayISO()) setDate(meta.takenOn);

    const { latitude, longitude } = meta;
    if (latitude === undefined || longitude === undefined) return;
    if (userSetLocation.current) return; // they told us where — don't second-guess it

    // Coordinates first, name second: the fix alone is enough to submit, so
    // commit it before the network call that might not come back.
    const coords = { lat: latitude, lon: longitude };
    setLatInput(String(latitude));
    setLonInput(String(longitude));
    setLocation({ ...coords, name: `${latitude}, ${longitude}` });
    setMode('coords');
    setAutoLocated(true);
    setSuggestions([]);

    setReadingExif(true);
    const placeName = await reverseGeocode(latitude, longitude);
    if (token !== photoToken.current) return; // a newer photo owns the form now
    setReadingExif(false);
    if (!placeName) return; // the coordinates stand on their own

    // Naming succeeded — show it the way a picked search result looks. Matching
    // `query` to `location.name` is what keeps the search effect from firing.
    setMode('address');
    setLocation({ ...coords, name: placeName });
    setQuery(placeName);
    setName((current) => current.trim() || placeName.split(',')[0].trim());
  }

  /** Drop an EXIF-derived location and hand the fields back to the submitter. */
  function clearAutoLocation() {
    photoToken.current++; // orphan any in-flight lookup so it can't refill this
    userSetLocation.current = false;
    setReadingExif(false);
    setAutoLocated(false);
    setLocation(null);
    setQuery('');
    setLatInput('');
    setLonInput('');
    setSuggestions([]);
  }

  function pickSuggestion(s: GeocodeResult) {
    photoToken.current++; // a chosen place outranks any lookup still in flight
    userSetLocation.current = true;
    setAutoLocated(false);
    const lat = parseFloat(s.lat);
    const lon = parseFloat(s.lon);
    setLocation({ lat, lon, name: s.display_name });
    setQuery(s.display_name);
    setSuggestions([]);
    if (!name.trim()) setName(s.display_name.split(',')[0].trim());
  }

  // Lat/Lng entered manually → unified into `location` when both parse to a valid pair.
  function onCoordChange(nextLat: string, nextLon: string) {
    photoToken.current++;
    setAutoLocated(false);
    setLatInput(nextLat);
    setLonInput(nextLon);
    const coords = parseCoords(`${nextLat}, ${nextLon}`);
    // Half-typed coordinates aren't an answer yet, so a photo may still fill in.
    userSetLocation.current = coords !== null;
    setLocation(
      coords ? { lat: coords.lat, lon: coords.lon, name: `${coords.lat}, ${coords.lon}` } : null,
    );
  }

  // Typing/pasting into one of the two coordinate boxes. If a whole "lat, lng"
  // pair lands in either box (e.g. coordinates copied from Google Maps), split
  // it across both; otherwise treat the text as just that one value.
  function handleCoordInput(raw: string, which: 'lat' | 'lon') {
    const m = raw.trim().match(COORD_PAIR_RE);
    if (m) {
      onCoordChange(m[1], m[2]);
      return;
    }
    if (which === 'lat') onCoordChange(raw, lonInput);
    else onCoordChange(latInput, raw);
  }

  // Switch between Address and Lat/Lng entry, clearing the other mode's state.
  function switchMode(next: 'address' | 'coords') {
    if (next === mode) return;
    setMode(next);
    photoToken.current++;
    userSetLocation.current = false;
    setAutoLocated(false);
    setLocation(null);
    setSuggestions([]);
    setQuery('');
    setLatInput('');
    setLonInput('');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!location) return setError('Please set a location — search an address or enter latitude/longitude.');
    if (!name.trim()) return setError('Please give the location a name.');

    // Photo is optional, but nudge once if it's missing — a second click sends it.
    if (!processed && !confirmNoPhoto) {
      setConfirmNoPhoto(true);
      return;
    }

    setStatus('submitting');
    const fd = new FormData();
    if (processed) fd.append('photo', processed.blob, processed.name); // photo is optional
    fd.append('name', name.trim());
    fd.append('latitude', String(location.lat));
    fd.append('longitude', String(location.lon));
    fd.append('date', date);
    fd.append('description', description.trim());
    fd.append('placedBy', placedBy.trim());

    try {
      const res = await fetch('/api/submit', { method: 'POST', body: fd });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Something went wrong. Please try again.');
      }
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  // Clear every field back to a blank form for another submission.
  function resetForm() {
    setProcessed(null);
    setPreview(null);
    setProcessing(false);
    setQuery('');
    setSuggestions([]);
    setSearching(false);
    setLocation(null);
    setMode('address');
    setLatInput('');
    setLonInput('');
    setName('');
    setPlacedBy('');
    setDate(todayISO());
    setDateTouched(false);
    photoToken.current++;
    userSetLocation.current = false;
    setAutoLocated(false);
    setReadingExif(false);
    setDescription('');
    setError('');
    setConfirmNoPhoto(false);
    setStatus('idle');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  if (status === 'success') {
    return (
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🎉</div>
        <h2 style={{ color: 'var(--text)', marginBottom: '0.5rem' }}>Thanks for the sighting!</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1.25rem' }}>
          It’s pending review and will appear on the map once approved.
        </p>
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={resetForm} className="poc-cta-button" style={{ border: 'none' }}>
            Submit another
          </button>
          <a
            href="/"
            className="poc-cta-button"
            style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}
          >
            Back to the map →
          </a>
        </div>
      </div>
    );
  }

  const submitting = status === 'submitting';

  return (
    <form className="card" onSubmit={onSubmit} noValidate>
      {/* Photo */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="photo">
          Photo of the sticker <span style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <p style={{ color: 'var(--muted)', fontSize: '0.75rem', margin: '0 0 0.4rem' }}>
          If it was taken with location on, we’ll fill in where it was for you.
        </p>
        <input
          id="photo"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onPhotoChange}
          style={{ ...inputStyle, padding: '0.5rem' }}
        />
        {processing && (
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: '0.4rem' }}>
            Reading photo…
          </p>
        )}
        {preview && !processing && (
          <img
            src={preview}
            alt="Preview"
            style={{
              marginTop: '0.6rem',
              width: '100%',
              maxHeight: '240px',
              objectFit: 'cover',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          />
        )}
      </div>

      {/* Location — Address (default) or Lat / Lng */}
      <div style={{ ...fieldStyle, position: 'relative' }}>
        <label style={labelStyle}>Where is it?</label>

        {/* Filled from the photo's EXIF — say so, and make it one click to undo. */}
        {autoLocated && (
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'center',
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent-border)',
              borderRadius: '8px',
              padding: '0.5rem 0.7rem',
              marginBottom: '0.6rem',
              fontSize: '0.8rem',
              color: 'var(--text)',
              lineHeight: 1.45,
            }}
          >
            <span aria-hidden="true">📷</span>
            <span style={{ flex: 1 }}>
              {readingExif
                ? 'Location filled in from your photo — looking up the place name…'
                : 'Location filled in from your photo. Not right? Set it yourself.'}
            </span>
            <button
              type="button"
              onClick={clearAutoLocation}
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                color: 'var(--text)',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '0.25rem 0.5rem',
                whiteSpace: 'nowrap',
              }}
            >
              Clear
            </button>
          </div>
        )}

        {/* Mode toggle — Address first, then Lat / Lng */}
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
          {([
            ['address', 'Address'],
            ['coords', 'Lat / Lng'],
          ] as const).map(([m, lbl]) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              style={{
                flex: 1,
                padding: '0.4rem 0.5rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                borderRadius: '8px',
                border: `1px solid ${mode === m ? 'var(--accent-border)' : 'var(--border)'}`,
                background: mode === m ? 'var(--accent-soft)' : 'transparent',
                color: 'var(--text)',
              }}
            >
              {lbl}
            </button>
          ))}
        </div>

        {mode === 'address' ? (
          <>
            <input
              id="place"
              type="text"
              placeholder="Search a place or address…"
              value={query}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setAutoLocated(false);
                userSetLocation.current = false;
                if (location) setLocation(null);
              }}
              style={inputStyle}
            />
            {searching && (
              <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: '0.4rem' }}>
                Searching…
              </p>
            )}
            {suggestions.length > 0 && (
              <ul
                style={{
                  listStyle: 'none',
                  margin: '0.3rem 0 0',
                  padding: 0,
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  background: 'var(--bg-card)',
                  overflow: 'hidden',
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  zIndex: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                }}
              >
                {suggestions.map((s) => (
                  <li key={s.place_id}>
                    <button
                      type="button"
                      onClick={() => pickSuggestion(s)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '0.55rem 0.75rem',
                        background: 'transparent',
                        border: 'none',
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--text)',
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                      }}
                    >
                      {s.display_name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <input
              type="text"
              aria-label="Latitude"
              placeholder="Latitude (e.g. 40.4237)"
              value={latInput}
              onChange={(e) => handleCoordInput(e.target.value, 'lat')}
              style={{ ...inputStyle, flex: 1 }}
            />
            <input
              type="text"
              aria-label="Longitude"
              placeholder="Longitude (e.g. -86.9212)"
              value={lonInput}
              onChange={(e) => handleCoordInput(e.target.value, 'lon')}
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>
        )}

        {location && (
          <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: '0.4rem' }}>
            📍 {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
          </p>
        )}
        {mode === 'coords' && !location && (latInput || lonInput) && (
          <p style={{ color: 'var(--muted)', fontSize: '0.72rem', marginTop: '0.4rem' }}>
            Enter a valid latitude (−90 to 90) and longitude (−180 to 180).
          </p>
        )}
        {mode === 'coords' && !location && !latInput && !lonInput && (
          <p style={{ color: 'var(--muted)', fontSize: '0.72rem', marginTop: '0.4rem' }}>
            Tip: paste coordinates copied from Google Maps (e.g.{' '}
            <code style={{ color: 'var(--accent)' }}>40.4237, -86.9212</code>) into either box —
            they’ll split automatically.
          </p>
        )}
        {mode === 'address' && (
          <p style={{ color: 'var(--muted)', fontSize: '0.7rem', marginTop: '0.35rem' }}>
            Place search ©{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--muted)', textDecoration: 'underline' }}
            >
              OpenStreetMap
            </a>{' '}
            contributors
          </p>
        )}
      </div>

      {/* Location name */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="name">
          Location name
        </label>
        <input
          id="name"
          type="text"
          placeholder="e.g. Top of Mount Rainier"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
      </div>

      {/* Your name + date */}
      <div style={{ display: 'flex', gap: '0.75rem', ...fieldStyle }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="placedBy">
            Your name <span style={{ fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id="placedBy"
            type="text"
            value={placedBy}
            onChange={(e) => setPlacedBy(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="date">
            Date
          </label>
          <input
            id="date"
            type="date"
            value={date}
            max={todayISO()}
            onChange={(e) => {
              setDateTouched(true);
              setDate(e.target.value);
            }}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Description */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="description">
          Description <span style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea
          id="description"
          rows={3}
          placeholder="Where exactly is the sticker at this address/location? e.g. on the trailhead sign, the second lamppost by the entrance"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>

      {confirmNoPhoto && !processed && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'flex-start',
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.45)',
            borderRadius: '8px',
            padding: '0.7rem 0.85rem',
            marginBottom: '0.9rem',
            fontSize: '0.85rem',
            color: 'var(--text)',
            lineHeight: 1.5,
          }}
        >
          <span aria-hidden="true">⚠️</span>
          <span>
            No photo attached. A photo helps others recognize the sticker — click{' '}
            <strong>Submit without a photo</strong> again to send it anyway.
          </span>
        </div>
      )}

      {error && (
        <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '0.9rem' }}>{error}</p>
      )}

      <button
        type="submit"
        className="poc-cta-button"
        disabled={submitting || processing}
        style={{ width: '100%', border: 'none', opacity: submitting || processing ? 0.6 : 1 }}
      >
        {submitting
          ? 'Submitting…'
          : confirmNoPhoto && !processed
            ? 'Submit without a photo →'
            : 'Submit sighting →'}
      </button>

      <p style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.75rem', textAlign: 'center' }}>
        Submissions are reviewed before they appear on the map.
      </p>
    </form>
  );
}
