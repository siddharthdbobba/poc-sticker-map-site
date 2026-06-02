/**
 * review-live.ts — the REAL submission-reviewer agent.
 *
 * Same agent shape as review.ts, but wired to the live data instead of fixtures:
 *   • reads pending rows from the Google Sheet  (Apps Script `listPending`)
 *   • LOOKS at each photo                        (get_photo → vision)
 *   • verifies the coordinates                   (reverse_geocode)
 *   • writes the verdict back to the Sheet       (Apps Script `setStatus`)
 *
 * Verdict → status mapping (must match src/lib/stickers.ts visibility rules):
 *   approve     → "active"    (appears on the map)
 *   reject      → "rejected"  (hidden)
 *   needs_human → "review"    (hidden; drops out of the pending queue for a human)
 *
 * SAFETY: DRY_RUN defaults to true. The first runs review and PRINT verdicts but
 * write nothing. Set DRY_RUN=false in .env only once you trust the decisions.
 *
 * Run:  npm run review:live      (after `npm install` and filling in .env)
 */

import 'dotenv/config';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const WEBHOOK_URL = need('SHEET_WEBHOOK_URL');
const WEBHOOK_TOKEN = need('SHEET_WEBHOOK_TOKEN');
const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const MODEL = process.env.MODEL ?? 'claude-sonnet-4-6';
const MAX = Number(process.env.MAX_SUBMISSIONS ?? '25');
const TODAY = new Date().toISOString().slice(0, 10);

interface Pending {
  name: string;
  latitude: string;
  longitude: string;
  date: string;
  description: string;
  photo_url: string;
  placed_by: string;
}

interface Result {
  name: string;
  decision: 'approve' | 'reject' | 'needs_human';
  status: string;
  confidence: string;
  reasons: string;
}

const DECISION_TO_STATUS = { approve: 'active', reject: 'rejected', needs_human: 'review' } as const;

// The submission currently under review. The mutating tools (get_photo,
// record_decision) act on THIS — the agent decides the verdict, but it can never
// act on the wrong row, because the driver fixes the subject.
let current: Pending | null = null;
const results: Result[] = [];

// POST a JSON action to the Apps Script web app and confirm the `ok` flag (Apps
// Script returns HTTP 200 even when it rejects the token).
async function webhook(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: WEBHOOK_TOKEN, ...payload }),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* fall through to the error below */
  }
  if (!res.ok || data.ok !== true) {
    throw new Error(`webhook "${payload.action ?? 'append'}" failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return data;
}

// ── TOOL: look at the actual sticker photo (vision) ─────────────────────────
const getPhoto = tool(
  'get_photo',
  'Fetch and look at the photo for the submission under review, so you can see what the sticker is and where it is.',
  {},
  async () => {
    if (!current) return { content: [{ type: 'text', text: 'No submission in context.' }] };
    try {
      const res = await fetch(current.photo_url);
      if (!res.ok) return { content: [{ type: 'text', text: `Could not fetch photo (HTTP ${res.status}).` }] };
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // Claude vision supports jpeg/png/webp. The submit pipeline can store HEIC
      // when a browser couldn't convert it (see api/submit.ts) — that's NOT
      // viewable, so fall back to text and let the agent defer to needs_human.
      let media: 'image/jpeg' | 'image/png' | 'image/webp' | null = null;
      if (ct.includes('png')) media = 'image/png';
      else if (ct.includes('webp')) media = 'image/webp';
      else if (ct.includes('jpeg') || ct.includes('jpg')) media = 'image/jpeg';
      if (!media) {
        return { content: [{ type: 'text', text: `Photo is "${ct}" and can't be displayed (likely HEIC). You cannot see it — judge from metadata or choose needs_human.` }] };
      }
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      return { content: [{ type: 'image', data, mimeType: media }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Photo fetch error: ${String(err)}` }] };
    }
  },
);

// ── TOOL: verify the coordinates ────────────────────────────────────────────
const reverseGeocode = tool(
  'reverse_geocode',
  'Look up the real-world place (address, city, region, country) for a latitude/longitude via OpenStreetMap, to check it matches the claimed location.',
  {
    latitude: z.number().describe('Decimal degrees, -90 to 90'),
    longitude: z.number().describe('Decimal degrees, -180 to 180'),
  },
  async ({ latitude, longitude }) => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14`,
        { headers: { 'User-Agent': 'sticker-map-submission-reviewer/0.1', Accept: 'application/json' } },
      );
      if (!res.ok) return { content: [{ type: 'text', text: `Lookup failed (HTTP ${res.status}).` }] };
      const data = (await res.json()) as { display_name?: string; error?: string };
      if (!data.display_name || data.error) {
        return { content: [{ type: 'text', text: 'No place found for these coordinates (open water or uninhabited area).' }] };
      }
      return { content: [{ type: 'text', text: `Coordinates resolve to: ${data.display_name}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Lookup error: ${String(err)}` }] };
    }
  },
);

// ── TOOL: record the verdict — writes back to the live Sheet (unless DRY_RUN) ─
const recordDecision = tool(
  'record_decision',
  'Record the final verdict for the submission under review. Call this exactly once.',
  {
    decision: z.enum(['approve', 'reject', 'needs_human']),
    confidence: z.enum(['low', 'medium', 'high']),
    reasons: z.string().describe('One or two sentences explaining the verdict.'),
  },
  async ({ decision, confidence, reasons }) => {
    if (!current) return { content: [{ type: 'text', text: 'No submission in context.' }] };
    const status = DECISION_TO_STATUS[decision];
    results.push({ name: current.name, decision, status, confidence, reasons });
    if (DRY_RUN) {
      return { content: [{ type: 'text', text: `DRY RUN: would set status="${status}" (nothing written).` }] };
    }
    await webhook({ action: 'setStatus', photo_url: current.photo_url, status });
    return { content: [{ type: 'text', text: `Set status="${status}".` }] };
  },
);

const reviewTools = createSdkMcpServer({
  name: 'review',
  version: '1.0.0',
  tools: [getPhoto, reverseGeocode, recordDecision],
});

const POLICY = `You are a moderation reviewer for a community "sticker sighting" map.
Each submission has: name (the place), latitude, longitude, date, description,
photo_url, and placed_by. Today's date is ${TODAY}.

Always, in this order:
  1. Call get_photo to LOOK at the sticker image.
  2. Call reverse_geocode on the coordinates to confirm the real-world place.
  3. Apply the rules below and call record_decision exactly once.

Decision rules:
  • approve     — the photo plausibly shows a sticker in a real place; the claimed
                  location name is geographically consistent with the coordinates
                  (same feature/city/region); nothing spammy or offensive in the
                  photo or text; the date is not in the future.
  • reject      — spam, advertising, links or social handles, offensive/hateful
                  content (in the PHOTO or the text), gibberish, an image that
                  clearly isn't a sticker sighting, or coordinates that plainly
                  contradict the named place (e.g. a landmark but coordinates in
                  open ocean or on another continent).
  • needs_human — genuinely borderline/uncertain, OR the photo could not be
                  displayed and the metadata alone isn't enough to decide.

HARD RULE: never "approve" unless you can ACTUALLY SEE and describe the sticker in
the photo. If get_photo did not return a viewable image — for any reason — you may
only choose "reject" or "needs_human", never "approve". (Approving makes the
submission public on the map, so a sighting you can't see must not go live.)

Be decisive and concise. Never ask the user questions.`;

function logStep(message: any) {
  if (message.type !== 'assistant') return;
  for (const block of message.message.content) {
    if (block.type === 'text' && block.text.trim()) {
      console.log(`   💭 ${block.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
    } else if (block.type === 'tool_use') {
      const args = block.name === 'get_photo' ? '' : JSON.stringify(block.input);
      console.log(`   🔧 ${block.name}(${args})`);
    }
  }
}

async function reviewOne(sub: Pending) {
  current = sub;
  console.log(`\n━━ "${sub.name}"  (${sub.latitude}, ${sub.longitude})  by ${sub.placed_by || 'anon'} ━━`);

  const result = query({
    prompt:
      `A submission is pending review:\n${JSON.stringify(sub, null, 2)}\n\n` +
      `Look at the photo, verify the location, then record your verdict.`,
    options: {
      model: MODEL,
      systemPrompt: POLICY,
      mcpServers: { review: { type: 'sdk', name: 'review', instance: reviewTools.instance } },
      allowedTools: ['mcp__review__get_photo', 'mcp__review__reverse_geocode', 'mcp__review__record_decision'],
      permissionMode: 'bypassPermissions',
      maxTurns: 8,
    },
  });

  for await (const message of result) logStep(message);
}

async function main() {
  console.log(`Reviewer starting — DRY_RUN=${DRY_RUN}, model=${MODEL}, today=${TODAY}.`);

  const { pending } = (await webhook({ action: 'listPending' })) as { pending: Pending[] };
  console.log(`${pending.length} pending submission(s).`);
  if (pending.length === 0) return;

  const batch = pending.slice(0, MAX);
  if (pending.length > MAX) console.log(`(reviewing the first ${MAX} this run)`);

  for (const sub of batch) await reviewOne(sub);

  console.log('\n════════ SUMMARY ════════');
  for (const r of results) {
    const icon = r.decision === 'approve' ? '✅' : r.decision === 'reject' ? '❌' : '🔎';
    console.log(`${icon} ${r.status.padEnd(8)} ${r.name.slice(0, 38).padEnd(38)} (${r.confidence}) — ${r.reasons}`);
  }
  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was written to the Sheet. Set DRY_RUN=false in .env to apply.');
  } else {
    console.log('\nApplied: approved → "active" (now on the map), rejected → "rejected", deferred → "review".');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
