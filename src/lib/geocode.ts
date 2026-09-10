/**
 * geocode.ts
 *
 * Coordinates → a human place name, in the browser, via Nominatim.
 *
 * Shared by /submit (naming a photo's EXIF fix, and sanity-checking hand-typed
 * coordinates) and /admin (naming each pending row before an officer approves
 * it). It exists as its own module because those two callers must not drift:
 * they are the two places a wrong coordinate can still be caught by a person.
 *
 * Why this matters more than it looks. Coordinates are unreadable — nobody spots
 * that `61.489833, 144.014694` is wrong. Coordinates with a name attached are
 * obvious: "Okhotsk, Khabarovsk Krai, Russia" is not the bridge in Alaska
 * anybody meant. A dropped minus sign is the single most likely error in a
 * hand-entered coordinate, and it moves the point roughly half a world away, so
 * showing the resolved name is a near-perfect detector for it. That really
 * happened here: three Alaska sightings were submitted, two lost the sign on the
 * longitude, and both were approved and sat on the public map plotted in the
 * Russian Far East.
 *
 * Not pure — it fetches. That is the whole point of keeping it out of
 * src/lib/stickers.ts, which must stay pure.
 *
 * Nominatim is a free, donation-funded service. Its usage policy asks for at
 * most one request per second and no bulk querying, so every caller debounces
 * or serialises; see `reverseGeocodeAll` for the queue the admin panel uses.
 */

/** Roughly neighbourhood/POI granularity — enough to recognise a place, short
 *  of a full street address. */
const ZOOM = 16;

/** Nominatim asks for ≤1 request/second. Keep a little headroom. */
const MIN_INTERVAL_MS = 1100;

/**
 * Name one point. Returns null on any failure — a naming miss is a missing
 * convenience, never an error worth showing or worth blocking a submission.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=json&zoom=${ZOOM}` +
      `&lat=${encodeURIComponent(String(latitude))}` +
      `&lon=${encodeURIComponent(String(longitude))}`;
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Name several points, one at a time, spaced to respect the usage policy —
 * calling `onResult` as each lands so a queue fills in progressively instead of
 * blocking on the slowest lookup.
 *
 * Returns a function that stops the run, for an unmount or a queue refresh.
 */
export function reverseGeocodeAll(
  points: { key: string; latitude: number; longitude: number }[],
  onResult: (key: string, place: string | null) => void,
): () => void {
  let stopped = false;
  const controller = new AbortController();

  void (async () => {
    for (const p of points) {
      if (stopped) return;
      const place = await reverseGeocode(p.latitude, p.longitude, controller.signal);
      if (stopped) return;
      onResult(p.key, place);
      await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
    }
  })();

  return () => {
    stopped = true;
    controller.abort();
  };
}

/**
 * A short, recognisable form of a Nominatim display_name.
 *
 * The full string is a comma-separated cascade from the most specific component
 * to the country ("Lansing-Edmond Road, Lansing, Fayette County, West Virginia,
 * 25837, United States"). For a sanity check the useful parts are the two ends:
 * what it is, and — the bit that catches a flipped sign — which country it is
 * in. The middle is noise in a narrow column.
 */
export function shortPlace(displayName: string): string {
  const parts = displayName.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 3) return parts.join(', ');
  return `${parts[0]}, … ${parts[parts.length - 1]}`;
}
