/**
 * LocationModal.tsx
 *
 * Full-screen lightbox for a single sticker — a large, uncropped photo plus all
 * of its details. Opened from LocationDrawer (the "Full screen" button or by
 * clicking the photo). Closes on the × button, a backdrop click, or Escape.
 * Layout + animation live in global.css (.sticker-modal*).
 */

import { useEffect } from 'react';
import type { StickerLocation } from '../lib/stickers';

interface LocationModalProps {
  location: StickerLocation | null;
  onClose: () => void;
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

export default function LocationModal({ location, onClose }: LocationModalProps) {
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
        {/* Large, uncropped photo (object-fit: contain on black) */}
        <div className="sticker-modal-photo">
          {location.photoUrl ? (
            <img src={location.photoUrl} alt={`POC sticker at ${location.name}`} />
          ) : (
            <div style={{ fontSize: '5rem' }}>🗺️</div>
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
