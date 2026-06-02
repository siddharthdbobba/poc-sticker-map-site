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
import LocationModal from './LocationModal';
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
  // Which lightbox pane is open (null = closed). 'photo' opens via the photo /
  // "Full screen" control; 'streetview' via the drawer's Street View button.
  const [modalView, setModalView] = useState<'photo' | 'streetview' | null>(null);
  // Street View coverage for the selected point + the (public) embed key, both
  // from /api/streetview. The key comes from the response — not a build-time var
  // — so the feature depends only on runtime secrets.
  const [streetView, setStreetView] = useState<{ available: boolean; embedKey: string }>({
    available: false,
    embedKey: '',
  });

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

  // Probe Street View coverage whenever a new marker is selected. The response
  // carries both availability and the embed key; we only treat it as available
  // when both are present (no key → no usable iframe). Reset first so a stale
  // result never leaks to the next point.
  useEffect(() => {
    setStreetView({ available: false, embedKey: '' });
    if (!selected) return;
    let cancelled = false;
    fetch(`/api/streetview?lat=${selected.latitude}&lng=${selected.longitude}`)
      .then((r) => r.json())
      .then((d: { available?: boolean; embedKey?: string }) => {
        if (!cancelled) {
          setStreetView({
            available: Boolean(d?.available && d?.embedKey),
            embedKey: d?.embedKey ?? '',
          });
        }
      })
      .catch(() => {
        if (!cancelled) setStreetView({ available: false, embedKey: '' });
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

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
            <LocationDrawer
              location={selected}
              onClose={() => {
                setSelected(null);
                setModalView(null);
              }}
              onExpand={() => setModalView('photo')}
              streetViewAvailable={streetView.available}
              onStreetView={() => setModalView('streetview')}
            />
            <LocationModal
              location={modalView ? selected : null}
              onClose={() => setModalView(null)}
              embedKey={streetView.embedKey}
              streetViewAvailable={streetView.available}
              initialView={modalView ?? 'photo'}
            />
          </>
        )}
      </div>
    </div>
  );
}
