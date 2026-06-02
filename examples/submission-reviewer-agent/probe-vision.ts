/**
 * Vision probe — run this ONCE before trusting review-live.ts.
 *
 * The live reviewer's photo check relies on one assumption the typechecker can't
 * verify: that an image returned from a custom tool actually reaches the model's
 * vision (vs. being silently dropped, which would make the agent "review" photos
 * it can't see). This 30-second test settles it.
 *
 *   npm run probe -- "https://YOUR-DOMAIN/photos/sightings/<uuid>.jpg"
 *
 * Use a photo with a SPECIFIC detail the model can't guess from the URL — legible
 * text, a number, a distinctive logo. Then:
 *   PASS  → the reply reads that exact detail back. Vision works; trust review-live.ts.
 *   FAIL  → "NO IMAGE RECEIVED", a vague/generic answer, or the wrong detail. The
 *           image isn't reaching the model — switch to embedding it in the prompt
 *           (streaming-input form) instead of a tool result.
 *
 * Why a specific detail: a model with no image can still invent a plausible
 * "I see a sticker," which would be a false PASS. A detail it cannot guess is the
 * only honest test.
 */

import 'dotenv/config';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npm run probe -- "<photo_url>"');
  process.exit(1);
}

const getPhoto = tool(
  'get_photo',
  'Fetch the photo so you can look at it.',
  {},
  async () => {
    const res = await fetch(url);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let media: 'image/jpeg' | 'image/png' | 'image/webp' | null = null;
    if (ct.includes('png')) media = 'image/png';
    else if (ct.includes('webp')) media = 'image/webp';
    else if (ct.includes('jpeg') || ct.includes('jpg')) media = 'image/jpeg';
    if (!media) return { content: [{ type: 'text', text: `Cannot display (${ct}).` }] };
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { content: [{ type: 'image', data, mimeType: media }] };
  },
);

const server = createSdkMcpServer({ name: 'probe', version: '1.0.0', tools: [getPhoto] });

const result = query({
  prompt:
    'Call get_photo, then report the most specific detail you can SEE in the image: ' +
    'read back any legible text or numbers verbatim, and name a distinctive logo or ' +
    'object. Do not guess from the file name or URL. If you did not actually receive ' +
    'a viewable image, reply with exactly: NO IMAGE RECEIVED.',
  options: {
    model: process.env.MODEL ?? 'claude-sonnet-4-6',
    systemPrompt: 'You are verifying whether tool-returned images are visible. Describe only what you literally see.',
    mcpServers: { probe: { type: 'sdk', name: 'probe', instance: server.instance } },
    allowedTools: ['mcp__probe__get_photo'],
    permissionMode: 'bypassPermissions',
    maxTurns: 4,
  },
});

for await (const message of result) {
  if (message.type === 'assistant') {
    for (const block of (message as any).message.content) {
      if (block.type === 'text' && block.text.trim()) console.log(block.text.trim());
    }
  }
}
