/**
 * LocationModal.tsx
 *
 * Full-screen lightbox for a single sticker — a large, uncropped photo plus all
 * of its details. Opened from LocationDrawer (the "Full screen" button, the
 * "Street View" button, or by clicking the photo). Closes on the × button, a
 * backdrop click, or Escape. Layout + animation live in global.css (.sticker-modal*).
 *
 * When the point has Google Street View coverage and an embed key is configured,
 * a Photo | Street View toggle swaps the media pane for an embedded panorama
 * (Maps Embed API, streetview mode — free, no per-load charge).
 */

import { useEffect, useState } from 'react';
import type { StickerLocation } from '../lib/stickers';

interface LocationModalProps {
  location: StickerLocation | null;
  onClose: () => void;
  /** Public Maps Embed API key. Absent → no Street View UI. */
  embedKey?: string;
  /** Whether Google has a panorama near this point (from /api/streetview). */
  streetViewAvailable?: boolean;
  /** Which pane to open on. Only honored for streetview when coverage exists. */
  initialView?: 'photo' | 'streetview';
}

const pill: React.CSSProperties = {
  background: 'var(--accent-soft)',
  border: '1px solid var(--accent-border)',
  borderRadius: '999px',
  padding: '4px 14px',
  fontSize: '0.82rem',
  color: 'var(--text)',
  fontWeight: 500,
};

export default function LocationModal({
  location,
  onClose,
  embedKey,
  streetViewAvailable = false,
  initialView = 'photo',
}: LocationModalProps) {
  const canStreetView = Boolean(embedKey) && streetViewAvailable;
  const [view, setView] = useState<'photo' | 'streetview'>('photo');

  // Reset the active pane whenever the modal (re)opens or a new initial view is
  // requested. Only honor a streetview request when coverage actually exists.
  useEffect(() => {
    setView(initialView === 'streetview' && canStreetView ? 'streetview' : 'photo');
  }, [location?.id, initialView, canStreetView]);

  // Close on Escape and lock background scroll while open.
  useEffect(() => {
    if (!location) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [location, onClose]);

  if (!location) return null;

  return (
    <div
      className="sticker-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${location.name} — full screen`}
    >
      <div className="sticker-modal" onClick={(e) => e.stopPropagation()}>
        {/* Media pane: the large photo, or the Street View panorama when toggled */}
        <div className="sticker-modal-photo">
          {view === 'streetview' && embedKey ? (
            <iframe
              title={`Street View near ${location.name}`}
              src={`https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(
                embedKey,
              )}&location=${location.latitude},${location.longitude}`}
              loading="lazy"
              allowFullScreen
              // Keep the default referrer policy: the Referer header is what
              // satisfies the embed key's HTTP-referrer restriction.
            />
          ) : location.photoUrl ? (
            <img src={location.photoUrl} alt={`POC sticker at ${location.name}`} />
          ) : (
            <div style={{ fontSize: '5rem' }}>🗺️</div>
          )}

          {/* Photo | Street View toggle — only when this point has coverage */}
          {canStreetView && (
            <div className="sticker-modal-tabs" role="tablist" aria-label="Media view">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'photo'}
                onClick={() => setView('photo')}
              >
                Photo
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'streetview'}
                onClick={() => setView('streetview')}
              >
                Street View
              </button>
            </div>
          )}
        </div>

        {/* Details */}
        <div className="sticker-modal-info">
          <h2
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              color: 'var(--text)',
              margin: '0 0 0.85rem',
              lineHeight: 1.25,
            }}
          >
            {location.name}
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.1rem' }}>
            {location.date && <span style={pill}>📅 {location.date}</span>}
            {location.placedBy && <span style={pill}>🏔️ {location.placedBy}</span>}
          </div>
          {location.description && (
            <p style={{ fontSize: '0.95rem', color: 'var(--muted)', lineHeight: 1.65, margin: 0 }}>
              {location.description}
            </p>
          )}
        </div>
      </div>

      {/* Close — pinned to the viewport corner so it's always reachable */}
      <button
        onClick={onClose}
        aria-label="Close full screen"
        style={{
          position: 'fixed',
          top: '16px',
          right: '16px',
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.25)',
          cursor: 'pointer',
          fontSize: '1.4rem',
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2001,
        }}
      >
        ×
      </button>
    </div>
  );
}
