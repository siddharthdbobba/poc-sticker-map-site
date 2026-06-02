/**
 * Submission-reviewer agent — a sample Claude Agent SDK app.
 *
 * This is the canonical "agent" shape: a model running in a LOOP with tools,
 * working toward a goal on its own. For each pending sticker-map submission it:
 *
 *   1. calls a custom `reverse_geocode` tool to find out what's *really* at the
 *      submitted coordinates (gather context),
 *   2. compares that to the claimed location name + description and applies a
 *      moderation policy (reason),
 *   3. calls a custom `record_decision` tool to write its verdict (take action).
 *
 * The three knobs you control are all visible below:
 *   • PROMPT      — the per-submission task + the POLICY system prompt
 *   • TOOLS       — `reverse_geocode` (gather) and `record_decision` (act)
 *   • PERMISSIONS — `permissionMode` (see the note near query() options)
 *
 * Toy vs. production: this reads from submissions.json and writes to ./decisions.
 * In your real site the same agent would read `status=pending` rows from the
 * Google Sheet and flip approved ones to `status=active` via the Apps Script
 * webhook (see apps-script/Code.gs). The agent logic doesn't change — only the
 * two tools' implementations do.
 */

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECISIONS_DIR = join(HERE, 'decisions');
const TODAY = new Date().toISOString().slice(0, 10);

interface Submission {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  date: string;
  description: string;
  photo_url: string;
  placed_by: string;
}

interface Decision {
  submissionId: string;
  decision: 'approve' | 'reject' | 'needs_human';
  confidence: 'low' | 'medium' | 'high';
  reasons: string;
}

// Collects every verdict the agent records, so we can print a summary at the end.
const decisions: Decision[] = [];

// ── TOOL 1 (gather context) ────────────────────────────────────────────────
// Reverse-geocode the submitted coordinates with OpenStreetMap Nominatim (the
// same service the site's submit form already uses). This lets the agent verify
// that the claimed place name is geographically plausible for the coordinates.
const reverseGeocode = tool(
  'reverse_geocode',
  'Look up the real-world place name (address, city, region, country) for a given latitude/longitude using OpenStreetMap. Use this to check whether a submission\'s claimed location matches its coordinates.',
  {
    latitude: z.number().describe('Latitude in decimal degrees, -90 to 90'),
    longitude: z.number().describe('Longitude in decimal degrees, -180 to 180'),
  },
  async ({ latitude, longitude }) => {
    try {
      const url =
        `https://nominatim.openstreetmap.org/reverse?format=json` +
        `&lat=${latitude}&lon=${longitude}&zoom=14`;
      const res = await fetch(url, {
        headers: {
          // Nominatim requires a descriptive User-Agent.
          'User-Agent': 'sticker-map-submission-reviewer/0.1 (sample agent)',
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        return { content: [{ type: 'text', text: `Lookup failed (HTTP ${res.status}).` }] };
      }
      const data = (await res.json()) as { display_name?: string; error?: string };
      // Nominatim returns `{ error: "Unable to geocode" }` for empty ocean /
      // "null island" (0,0) — handle it cleanly so a mismatch reads as a finding,
      // not a crash.
      if (!data.display_name || data.error) {
        return { content: [{ type: 'text', text: 'No place found for these coordinates (open water or uninhabited area).' }] };
      }
      return { content: [{ type: 'text', text: `Coordinates resolve to: ${data.display_name}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Lookup error: ${String(err)}` }] };
    }
  },
);

// ── TOOL 2 (take action) ───────────────────────────────────────────────────
// The agent calls this exactly once per submission to record its verdict.
// Here it writes a JSON file; in production this is where you'd PATCH the
// Google Sheet row (status -> "active") or notify a human queue.
const recordDecision = tool(
  'record_decision',
  'Record the final moderation verdict for one submission. Call this exactly once after you have reviewed the submission.',
  {
    submissionId: z.string(),
    decision: z.enum(['approve', 'reject', 'needs_human']),
    confidence: z.enum(['low', 'medium', 'high']),
    reasons: z.string().describe('One or two sentences explaining the verdict.'),
  },
  async ({ submissionId, decision, confidence, reasons }) => {
    const verdict: Decision = { submissionId, decision, confidence, reasons };
    decisions.push(verdict);
    mkdirSync(DECISIONS_DIR, { recursive: true });
    writeFileSync(join(DECISIONS_DIR, `${submissionId}.json`), JSON.stringify(verdict, null, 2));
    return { content: [{ type: 'text', text: `Recorded ${decision} for ${submissionId}.` }] };
  },
);

// Bundle both tools into an in-process MCP server. "In-process" means the tool
// code runs right here in this Node process — no separate server to start.
const reviewTools = createSdkMcpServer({
  name: 'review',
  version: '1.0.0',
  tools: [reverseGeocode, recordDecision],
});

// The POLICY. This becomes the agent's system prompt — it's a plain-English
// rulebook, not code. Editing these rules changes how the agent behaves.
const POLICY = `You are a moderation reviewer for a community "sticker sighting" map.
Members submit a photo of a sticker plus: name (the location), latitude, longitude,
date, description, photo_url, and placed_by (their name).

Today's date is ${TODAY}.

IMPORTANT: in this sample you cannot see the actual photo — judge from the metadata
and the reverse_geocode result only. When the photo would be the deciding factor,
choose "needs_human".

Process for every submission:
  1. ALWAYS call reverse_geocode on the coordinates first.
  2. Compare the resolved real-world place to the claimed "name" and "description".
  3. Apply the rules below and call record_decision exactly once.

Decision rules:
  • approve      — coherent sighting; the claimed location is geographically
                   consistent with the coordinates (same feature/city/region);
                   no spam or offensive content; date is not in the future.
  • reject       — spam, advertising, links/handles, offensive or hateful text,
                   gibberish, OR coordinates that clearly contradict the named
                   place (e.g. a famous landmark but coordinates in open ocean or
                   on a different continent).
  • needs_human  — genuinely borderline/uncertain, or the call hinges on the
                   unseen photo.

Be decisive and concise. Do not ask the user questions.`;

// ── Pretty-print what the agent is doing as it loops ────────────────────────
function logStep(message: any) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(`   💭 ${block.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
      } else if (block.type === 'tool_use') {
        console.log(`   🔧 ${block.name}(${JSON.stringify(block.input)})`);
      }
    }
  }
}

async function reviewOne(sub: Submission) {
  console.log(`\n━━ Reviewing ${sub.id}: "${sub.name}" ━━`);

  const result = query({
    prompt:
      `A new submission is pending review:\n${JSON.stringify(sub, null, 2)}\n\n` +
      `Verify it and record your verdict.`,
    options: {
      model: 'claude-sonnet-4-6', // moderation is light work; Haiku also works and is cheaper
      systemPrompt: POLICY, // a focused domain agent, NOT the coding-oriented "claude_code" preset
      mcpServers: {
        review: { type: 'sdk', name: 'review', instance: reviewTools.instance },
      },
      // The PERMISSIONS knob. "bypassPermissions" lets the agent run unattended
      // (no human at the keyboard). Switch to "default" and the SDK will prompt
      // before each tool call — that's how you'd put a human in the loop. The
      // namespaced names below are what "default" mode checks against.
      allowedTools: ['mcp__review__reverse_geocode', 'mcp__review__record_decision'],
      permissionMode: 'bypassPermissions',
      maxTurns: 6,
    },
  });

  for await (const message of result) {
    logStep(message);
  }
}

async function main() {
  const subs = JSON.parse(readFileSync(join(HERE, 'submissions.json'), 'utf8')) as Submission[];
  console.log(`Loaded ${subs.length} pending submission(s). Today is ${TODAY}.`);

  for (const sub of subs) {
    await reviewOne(sub);
  }

  console.log('\n\n════════ SUMMARY ════════');
  for (const d of decisions) {
    const icon = d.decision === 'approve' ? '✅' : d.decision === 'reject' ? '❌' : '🔎';
    console.log(`${icon} ${d.submissionId.padEnd(8)} ${d.decision.padEnd(12)} (${d.confidence}) — ${d.reasons}`);
  }
  console.log(`\nVerdicts written to ${DECISIONS_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
