/**
 * StickersMap.tsx
 *
 * Client-side interactive map built with Leaflet + react-leaflet.
 * Mounted via `client:only="react"` in Astro — Leaflet needs the browser's
 * window object, so it must never be server-rendered.
 */

import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useEffect, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import type { StickerLocation } from '../lib/stickers';

// ---------------------------------------------------------------------------
// Basemap follows the site theme (data-theme on <html>, set by the toggle in
// Base.astro and by live OS changes). Both routes mutate that attribute, so a
// MutationObserver catches every change. Light keeps the OpenStreetMap street
// map; dark is CARTO Dark Matter.
//
// CARTO now stamps "API KEY REQUIRED" across keyless basemaps.cartocdn.com
// tiles — they still return HTTP 200 with a valid PNG, so the watermark is the
// only symptom. A key (free tier) removes it, and `cartoKey` carries it in from
// /api/basemap at runtime. Without a key we fall back to Esri's keyless Dark
// Gray Canvas rather than serve a watermarked map: it's a lighter grey and
// ships labels as a separate reference layer, hence `layers` being an array.
// Esri also tops out at native zoom 16, so maxNativeZoom lets Leaflet overzoom
// the last few levels to keep parity with light's 19.
// ---------------------------------------------------------------------------
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

interface Basemap {
  attribution: string;
  maxZoom: number;
  maxNativeZoom: number;
  layers: string[];
}

const LIGHT_BASEMAP: Basemap = {
  attribution: OSM_ATTRIBUTION,
  maxZoom: 19,
  maxNativeZoom: 19,
  layers: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
};

function cartoBasemap(key: string): Basemap {
  return {
    attribution: `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 20,
    maxNativeZoom: 20,
    layers: [
      `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`,
    ],
  };
}

const ESRI_DARK_BASEMAP: Basemap = {
  attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, DeLorme, NAVTEQ',
  maxZoom: 19,
  maxNativeZoom: 16,
  layers: [
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  ],
};

function useSiteTheme(): 'light' | 'dark' {
  // Default to dark to match Base.astro's no-stored-choice fallback.
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'light'
      : 'dark',
  );
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setTheme(el.dataset.theme === 'light' ? 'light' : 'dark');
    read(); // sync in case it changed between first render and mount
    const observer = new MutationObserver(read);
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// ---------------------------------------------------------------------------
// Custom gold marker icon — uses the theme accent (var(--accent)).
// The marker color is fixed across themes; the dark border + gold fill stay
// readable on both the light street basemap and the dark CARTO basemap.
// Defined at module scope so it's created once, not on every render.
// ---------------------------------------------------------------------------
const pocMarkerIcon = L.divIcon({
  className: '', // suppresses the default .leaflet-div-icon white box
  html: `<div style="
    width: 18px;
    height: 18px;
    background: var(--accent);
    border: 3px solid #0a0a0a;
    border-radius: 50%;
    box-shadow: 0 2px 8px rgba(0,0,0,0.6), 0 0 0 2px rgba(245,197,24,0.3);
  "></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  popupAnchor: [0, -12],
});

// ---------------------------------------------------------------------------
// Fullscreen control — custom Leaflet control using the browser Fullscreen API.
// No plugin/dependency required. Rendered as a child of <MapContainer>.
// ---------------------------------------------------------------------------
const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const COMPRESS_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3a1 1 0 0 0 1-1V4M20 8h-3a1 1 0 0 1-1-1V4M4 16h3a1 1 0 0 1 1 1v3M20 16h-3a1 1 0 0 0-1 1v3"/></svg>';

function FullscreenControl() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();

    type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
    const doc = document as FsDoc;
    const el = container as FsEl;

    const isFullscreen = () =>
      doc.fullscreenElement === container || doc.webkitFullscreenElement === container;

    const control = new L.Control({ position: 'topleft' });
    let link: HTMLAnchorElement;

    control.onAdd = () => {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      link = L.DomUtil.create('a', 'poc-fullscreen-btn', div) as HTMLAnchorElement;
      link.href = '#';
      link.title = 'Toggle fullscreen';
      link.setAttribute('role', 'button');
      link.setAttribute('aria-label', 'Toggle fullscreen');
      link.innerHTML = EXPAND_ICON;

      L.DomEvent.on(link, 'click', (e) => {
        L.DomEvent.stop(e);
        if (isFullscreen()) {
          (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
        } else {
          (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
        }
      });
      L.DomEvent.disableClickPropagation(div);
      return div;
    };

    const onChange = () => {
      if (link) link.innerHTML = isFullscreen() ? COMPRESS_ICON : EXPAND_ICON;
      // Container resized — let Leaflet recompute tile coverage.
      map.invalidateSize();
    };

    doc.addEventListener('fullscreenchange', onChange);
    doc.addEventListener('webkitfullscreenchange', onChange);
    control.addTo(map);

    return () => {
      doc.removeEventListener('fullscreenchange', onChange);
      doc.removeEventListener('webkitfullscreenchange', onChange);
      control.remove();
    };
  }, [map]);

  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface StickersMapProps {
  locations: StickerLocation[];
  onMarkerClick: (loc: StickerLocation) => void;
  /** CARTO basemap key from /api/basemap. Empty string → keyless Esri fallback. */
  cartoKey: string;
}

export default function StickersMap({ locations, onMarkerClick, cartoKey }: StickersMapProps) {
  const theme = useSiteTheme();
  const basemap =
    theme === 'light' ? LIGHT_BASEMAP : cartoKey ? cartoBasemap(cartoKey) : ESRI_DARK_BASEMAP;

  return (
    <MapContainer
      center={[39.5, -98.35]}
      zoom={4}
      scrollWheelZoom={true}
      style={{ height: '600px', width: '100%', borderRadius: '0.5rem' }}
    >
      {/* Theme-aware basemap (street in light, CARTO Dark Matter in dark — or
          Esri's dark canvas when no CARTO key is configured, which ships labels
          as a second layer, hence the map over `layers`). The `key` forces a
          clean layer swap when the theme or the basemap identity changes. */}
      {basemap.layers.map((url, i) => (
        <TileLayer
          key={`${theme}-${Boolean(cartoKey)}-${i}`}
          attribution={i === 0 ? basemap.attribution : undefined}
          url={url}
          maxZoom={basemap.maxZoom}
          maxNativeZoom={basemap.maxNativeZoom}
        />
      ))}

      <FullscreenControl />

      {locations.map((loc) => (
        <Marker
          key={loc.id}
          position={[loc.latitude, loc.longitude]}
          icon={pocMarkerIcon}
          eventHandlers={{ click: () => onMarkerClick(loc) }}
        />
      ))}
    </MapContainer>
  );
}
