/**
 * SubmitForm.tsx
 *
 * Client island for /submit. Lets anyone contribute a sticker sighting:
 *   - pick a photo (downscaled in-browser before upload; HEIC falls back to original)
 *   - type a place → geocoded via Nominatim (client-side, light use only)
 *   - add a date / story / their name
 * Posts multipart form-data to /api/submit, which stores the photo in R2 and
 * appends a row to the Google Sheet "Pending" tab for review.
 *
 * Styling reuses the theme tokens from global.css (no new colors).
 */

import { useEffect, useRef, useState } from 'react';

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

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [location, setLocation] = useState<ChosenLocation | null>(null);

  const [name, setName] = useState('');
  const [placedBy, setPlacedBy] = useState('');
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState('');

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  const previewRef = useRef<string | null>(null);

  // Debounced client-side geocoding (Nominatim). Light use only.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || (location && q === location.name)) {
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
  }, [query, location]);

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
    if (file.size > MAX_BYTES * 3) {
      // Even the original is implausibly large; canvas resize would still help,
      // but guard against decoding something enormous.
      setError('That file is very large — please choose a photo under ~24 MB.');
      return;
    }
    setProcessing(true);
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
  }

  function pickSuggestion(s: GeocodeResult) {
    const lat = parseFloat(s.lat);
    const lon = parseFloat(s.lon);
    setLocation({ lat, lon, name: s.display_name });
    setQuery(s.display_name);
    setSuggestions([]);
    if (!name.trim()) setName(s.display_name.split(',')[0].trim());
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!processed) return setError('Please add a photo.');
    if (!location) return setError('Please choose a location from the search results.');
    if (!name.trim()) return setError('Please give the location a name.');

    setStatus('submitting');
    const fd = new FormData();
    fd.append('photo', processed.blob, processed.name);
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

  if (status === 'success') {
    return (
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🎉</div>
        <h2 style={{ color: 'var(--text)', marginBottom: '0.5rem' }}>Thanks for the sighting!</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1.25rem' }}>
          It’s pending review and will appear on the map once approved.
        </p>
        <a href="/" className="poc-cta-button">
          Back to the map →
        </a>
      </div>
    );
  }

  const submitting = status === 'submitting';

  return (
    <form className="card" onSubmit={onSubmit} noValidate>
      {/* Photo */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="photo">
          Photo of the sticker
        </label>
        <input
          id="photo"
          type="file"
          accept="image/*"
          onChange={onPhotoChange}
          style={{ ...inputStyle, padding: '0.5rem' }}
        />
        {processing && (
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: '0.4rem' }}>
            Optimizing photo…
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

      {/* Location search */}
      <div style={{ ...fieldStyle, position: 'relative' }}>
        <label style={labelStyle} htmlFor="place">
          Where is it?
        </label>
        <input
          id="place"
          type="text"
          placeholder="Search a place or address…"
          value={query}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            if (location) setLocation(null);
          }}
          style={inputStyle}
        />
        {searching && (
          <span
            style={{
              position: 'absolute',
              right: '0.75rem',
              top: '2.1rem',
              fontSize: '0.8rem',
              color: 'var(--muted)',
            }}
          >
            …
          </span>
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
        {location && (
          <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: '0.4rem' }}>
            📍 {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
          </p>
        )}
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
            onChange={(e) => setDate(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Description */}
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="description">
          The story <span style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea
          id="description"
          rows={3}
          placeholder="How did the sticker end up here?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>

      {error && (
        <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '0.9rem' }}>{error}</p>
      )}

      <button
        type="submit"
        className="poc-cta-button"
        disabled={submitting || processing}
        style={{ width: '100%', border: 'none', opacity: submitting || processing ? 0.6 : 1 }}
      >
        {submitting ? 'Submitting…' : 'Submit sighting →'}
      </button>

      <p style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.75rem', textAlign: 'center' }}>
        Submissions are reviewed before they appear on the map.
      </p>
    </form>
  );
}
