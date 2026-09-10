/**
 * directions.ts
 *
 * Turns a sticker's coordinates into "take me there" links for the two map apps
 * people actually have. Pure like the rest of src/lib — strings in, strings out,
 * no DOM and no fetch; the component decides how to render them.
 *
 * Both deep links use the *documented, stable* URL forms rather than the shapes
 * you get by copying a browser address bar, which carry session junk and change:
 *   - Google: the Maps URLs API (`/maps/dir/?api=1`), which works on the web and
 *     hands off to the native app on Android/iOS when it's installed.
 *   - Apple: the Maps URL scheme over https, so it opens Maps on Apple platforms
 *     and degrades to a web page everywhere else.
 *
 * Coordinates, not the place name, are the destination in both: the name here is
 * whatever a submitter typed ("behind the Co-Rec"), which a geocoder would miss
 * or, worse, resolve somewhere plausible and wrong. The name rides along only as
 * a label for the dropped pin.
 */

/**
 * Six decimal places ≈ 11 cm — past the accuracy of any phone GPS fix, and short
 * enough to read aloud. Trailing zeros are trimmed so a round number doesn't
 * look like false precision.
 */
export function formatCoord(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** "38.056283, -81.045136" — the display form, and what the copy button copies. */
export function formatCoords(latitude: number, longitude: number): string {
  return `${formatCoord(latitude)}, ${formatCoord(longitude)}`;
}

/** Driving directions to the point, in Google Maps. */
export function googleMapsUrl(latitude: number, longitude: number): string {
  const dest = encodeURIComponent(`${formatCoord(latitude)},${formatCoord(longitude)}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
}

/**
 * Directions to the point, in Apple Maps. `daddr` with no `saddr` means "from
 * where I am"; `q` names the dropped pin so the destination card reads as the
 * place rather than a bare coordinate.
 */
export function appleMapsUrl(latitude: number, longitude: number, name?: string): string {
  const dest = encodeURIComponent(`${formatCoord(latitude)},${formatCoord(longitude)}`);
  const label = name?.trim() ? `&q=${encodeURIComponent(name.trim())}` : '';
  return `https://maps.apple.com/?daddr=${dest}${label}&dirflg=d`;
}

/**
 * Which map app to offer first. Apple Maps is the built-in on iOS/iPadOS/macOS,
 * so leading with it there saves a tap for the people most likely to want it;
 * everyone else gets Google first. Cosmetic ordering only — both links are
 * always shown, so guessing wrong costs nothing.
 *
 * Guarded for SSR: this module is imported by components that also render on the
 * server, where there is no navigator.
 */
export function prefersAppleMaps(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, so the touch-point check catches it too.
  return /iPhone|iPad|iPod|Macintosh/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
}
