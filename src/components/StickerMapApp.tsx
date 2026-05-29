/**
 * StickerMapApp.tsx
 *
 * The single React island for the page (mounted with client:only="react").
 * Replaces the Next.js StickersMapLoader + the server component's data work:
 *   - fetches the public Google Sheet CSV client-side
 *   - parses it into StickerLocation[]
 *   - computes the stats (total stickers, unique explorers)
 *   - holds the selected-marker state and renders the map + drawer
 *
 * Because it's client:only, this (and Leaflet) only ever runs in the browser.
 */

import { useEffect, useState } from 'react';
import StickersMap from './StickersMap';
import LocationDrawer from './LocationDrawer';
import { parseCSV, type StickerLocation } from '../lib/stickers';

type Status = 'loading' | 'ready' | 'error';

function StatItem({
  emoji,
  value,
  label,
}: {
  emoji: string;
  value: string | number;
  label: string;
}) {
  return (
    <div style={{ textAlign: 'center', minWidth: '80px' }}>
      <div style={{ fontSize: '1.25rem' }}>{emoji}</div>
      <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--accent)' }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '1px' }}>{label}</div>
    </div>
  );
}

export default function StickerMapApp({ csvUrl }: { csvUrl: string }) {
  const [locations, setLocations] = useState<StickerLocation[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [selected, setSelected] = useState<StickerLocation | null>(null);

  useEffect(() => {
    if (!csvUrl) {
      setStatus('error');
      return;
    }
    let cancelled = false;
    fetch(csvUrl)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.text();
      })
      .then((csv) => {
        if (!cancelled) {
          setLocations(parseCSV(csv));
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [csvUrl]);

  const total = locations.length;
  const explorers = new Set(locations.map((l) => l.placedBy).filter(Boolean)).size;

  return (
    <div>
      {status === 'ready' && (
        <div className="stats-bar">
          <StatItem emoji="📍" value={total} label="stickers placed" />
          <div className="stats-divider" />
          <StatItem emoji="🧭" value={explorers || '—'} label="explorers" />
          <div className="stats-divider" />
          <StatItem emoji="🌍" value="Worldwide" label="coverage" />
        </div>
      )}

      <div style={{ position: 'relative' }}>
        {status === 'error' ? (
          <div className="map-message card">
            Couldn’t load sticker locations.
            <br />
            Set <code>PUBLIC_STICKER_CSV_URL</code> to the published Google Sheet CSV.
          </div>
        ) : status === 'loading' ? (
          <div className="map-skeleton" />
        ) : (
          <>
            <StickersMap locations={locations} onMarkerClick={setSelected} />
            <LocationDrawer location={selected} onClose={() => setSelected(null)} />
          </>
        )}
      </div>
    </div>
  );
}
