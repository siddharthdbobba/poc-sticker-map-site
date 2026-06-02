/**
 * LocationDrawer.tsx
 *
 * Slide-in detail panel that opens when a map marker is clicked.
 *   - Desktop: right-side panel (340px wide, full height)
 *   - Mobile:  bottom sheet (100% wide, 60vh)
 *
 * Animation, theming and responsive behaviour are handled in global.css
 * via the .sticker-drawer class. Colors use theme tokens so the drawer
 * follows light/dark mode.
 */

import type { StickerLocation } from '../lib/stickers';

interface LocationDrawerProps {
  location: StickerLocation | null;
  onClose: () => void;
  /** Open the full-screen lightbox for this sticker. */
  onExpand?: () => void;
}

export default function LocationDrawer({ location, onClose, onExpand }: LocationDrawerProps) {
  if (!location) return null;

  return (
    <div className="sticker-drawer">
      {/* ── Photo ────────────────────────────────────────────────── */}
      <div style={{ position: 'relative' }}>
        {location.photoUrl ? (
          <img
            src={location.photoUrl}
            alt={`POC sticker at ${location.name}`}
            onClick={onExpand}
            style={{
              width: '100%',
              height: '240px',
              objectFit: 'cover',
              display: 'block',
              cursor: onExpand ? 'zoom-in' : 'default',
            }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '180px',
              background: 'var(--bg-elev)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '3rem',
            }}
          >
            🗺️
          </div>
        )}

        {/* Close button — dark overlay chip, readable on any photo */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.15)',
            cursor: 'pointer',
            fontSize: '1.1rem',
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ×
        </button>

        {/* Expand to a full-screen view of the photo + details */}
        {onExpand && (
          <button
            onClick={onExpand}
            aria-label="View full screen"
            style={{
              position: 'absolute',
              bottom: '10px',
              right: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '999px',
              background: 'rgba(0,0,0,0.7)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.15)',
              cursor: 'pointer',
              fontSize: '0.78rem',
              fontWeight: 600,
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: 'block' }}
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            Full screen
          </button>
        )}
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div style={{ padding: '1.25rem 1.25rem 2rem' }}>
        {/* Location name */}
        <h2
          style={{
            fontSize: '1.3rem',
            fontWeight: 700,
            color: 'var(--text)',
            marginBottom: '0.75rem',
            lineHeight: 1.3,
          }}
        >
          {location.name}
        </h2>

        {/* Pill badges — gold-tinted, text uses --text for contrast in both themes */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          {location.date && (
            <span
              style={{
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent-border)',
                borderRadius: '999px',
                padding: '3px 12px',
                fontSize: '0.78rem',
                color: 'var(--text)',
                fontWeight: 500,
              }}
            >
              📅 {location.date}
            </span>
          )}
          {location.placedBy && (
            <span
              style={{
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent-border)',
                borderRadius: '999px',
                padding: '3px 12px',
                fontSize: '0.78rem',
                color: 'var(--text)',
                fontWeight: 500,
              }}
            >
              🏔️ {location.placedBy}
            </span>
          )}
        </div>

        {/* Description */}
        {location.description && (
          <p
            style={{
              fontSize: '0.9rem',
              color: 'var(--muted)',
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            {location.description}
          </p>
        )}
      </div>
    </div>
  );
}
