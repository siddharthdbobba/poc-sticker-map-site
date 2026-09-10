/**
 * Directions.tsx
 *
 * The "how do I actually get there" block, shared by LocationDrawer (side panel)
 * and LocationModal (lightbox) so the two can't drift apart.
 *
 * Three affordances, in the order people reach for them:
 *   1. The coordinates, in plain text — copyable, and the only thing that still
 *      works with no signal, which is the situation a lot of these pins are in.
 *   2. Google Maps.
 *   3. Apple Maps.
 * Both map links open directions from the viewer's current location; see
 * src/lib/directions.ts for why they point at coordinates rather than the name.
 *
 * `compact` gives the drawer a tighter version — that panel is 340px wide and
 * competes with the photo for height.
 */

import { useEffect, useState } from 'react';
import {
  appleMapsUrl,
  formatCoords,
  googleMapsUrl,
  prefersAppleMaps,
} from '../lib/directions';

interface DirectionsProps {
  latitude: number;
  longitude: number;
  /** Labels the dropped pin in Apple Maps. */
  name?: string;
  compact?: boolean;
}

export default function Directions({ latitude, longitude, name, compact = false }: DirectionsProps) {
  const coords = formatCoords(latitude, longitude);
  const [copied, setCopied] = useState(false);

  // Decided after mount, never during render: `client:only` islands still run a
  // first render whose output must not depend on the user agent, and the answer
  // only changes ordering. Default false → Google first until we know better.
  const [appleFirst, setAppleFirst] = useState(false);
  useEffect(() => setAppleFirst(prefersAppleMaps()), []);

  // Reset the "Copied" flash after a beat, and whenever the pin changes.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => setCopied(false), [coords]);

  async function copyCoords() {
    try {
      await navigator.clipboard.writeText(coords);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure context, permissions policy).
      // The coordinates are on screen and selectable, so there's nothing to fix
      // and nothing worth interrupting the viewer about.
    }
  }

  const links = [
    { key: 'google', label: 'Google Maps', href: googleMapsUrl(latitude, longitude) },
    { key: 'apple', label: 'Apple Maps', href: appleMapsUrl(latitude, longitude, name) },
  ];
  if (appleFirst) links.reverse();

  const linkStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.35rem',
    padding: compact ? '0.45rem 0.5rem' : '0.55rem 0.75rem',
    borderRadius: '8px',
    border: '1px solid var(--accent-border)',
    background: 'var(--accent-soft)',
    color: 'var(--text)',
    fontSize: compact ? '0.8rem' : '0.85rem',
    fontWeight: 600,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={{ marginTop: compact ? '1rem' : '1.25rem' }}>
      <div
        style={{
          fontSize: '0.72rem',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--muted)',
          fontWeight: 700,
          marginBottom: '0.45rem',
        }}
      >
        Get there
      </div>

      {/* Coordinates — click to copy. A button, not a <p>, because it does something. */}
      <button
        type="button"
        onClick={copyCoords}
        title="Copy coordinates"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          width: '100%',
          padding: compact ? '0.4rem 0.6rem' : '0.5rem 0.7rem',
          marginBottom: '0.5rem',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          background: 'transparent',
          color: 'var(--text)',
          fontSize: compact ? '0.8rem' : '0.85rem',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span>📍 {coords}</span>
        <span style={{ color: 'var(--muted)', fontSize: '0.72rem', fontFamily: 'inherit' }}>
          {copied ? 'Copied' : 'Copy'}
        </span>
      </button>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {links.map((l) => (
          <a
            key={l.key}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            style={linkStyle}
          >
            {l.label} ↗
          </a>
        ))}
      </div>
    </div>
  );
}
