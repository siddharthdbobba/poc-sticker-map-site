# Submission-reviewer agent (Claude Agent SDK sample)

A tiny, self-contained example of an **agent** — a Claude model running in a loop
with tools, doing a real task on its own. It moderates pending sticker-map
submissions: for each one it looks up what's actually at the coordinates, compares
that to the claimed location, applies a policy, and records an approve / reject /
needs-human verdict.

It is **completely separate** from the main site — its own folder, its own
`package.json`, nothing here imports or touches your Astro/Cloudflare code.

## The whole idea in one picture

```
submissions.json ──► [ agent loop ]  ──► decisions/<id>.json
                         │
                         ├─ reverse_geocode(lat,lng)   ← gather context (custom tool)
                         ├─ ...reason against POLICY...
                         └─ record_decision(verdict)   ← take action   (custom tool)
```

Everything you build with the SDK is just **three knobs**, all visible in `review.ts`:

| Knob | Where | What it is |
|------|-------|------------|
| **Prompt** | `POLICY` + the per-submission prompt | the goal + the rulebook, in plain English |
| **Tools** | `reverse_geocode`, `record_decision` | what the agent is *able* to do |
| **Permissions** | `permissionMode` | what it may do without asking |

## Run it

```bash
cd examples/submission-reviewer-agent
npm install

# The SDK needs an Anthropic API key:
export ANTHROPIC_API_KEY=sk-ant-...        # from https://console.anthropic.com

npm run review
```

You'll see each submission stream by — the agent calling `reverse_geocode`,
thinking, then calling `record_decision` — followed by a summary table. Verdicts
are also written to `./decisions/`.

### What to expect from the three sample submissions

| id | why it's here | likely verdict |
|----|---------------|----------------|
| `sub_001` Mount Rainier | clean, coordinates match the name | ✅ approve |
| `sub_002` "Eiffel Tower" at `0,0` | coordinates (null island / open ocean) contradict the claimed landmark | ❌ reject |
| `sub_003` "BUY CHEAP FOLLOWERS…" | spam / advertising in the text | ❌ reject |

(LLM output isn't perfectly deterministic, so a borderline case may land on
`needs_human` — that's the agent being appropriately cautious, not a bug.)

## Try changing things (to feel how it works)

- **Edit the policy** in `review.ts` (e.g. "reject any submission with a future
  date") and re-run — behavior changes with no code change.
- **Flip the permissions knob**: set `permissionMode: 'default'` and the SDK will
  prompt before each tool call — that's how you put a human in the loop.
- **Add a submission** to `submissions.json` and watch it get reviewed.
- **Swap the model**: `claude-haiku-4-5-20251001` is cheaper for simple moderation.

## How this maps to the real site

This sample uses local files so it runs with zero setup. To wire it to your
actual flow, only the **two tools' implementations** change — the agent logic
stays identical:

| Sample (toy) | Production (your site) |
|--------------|------------------------|
| reads `submissions.json` | read `status=pending` rows from the Google Sheet |
| `record_decision` writes a JSON file | approve → set the row's `status` to `active` via the Apps Script webhook (`apps-script/Code.gs`); reject → leave/flag it |
| photo is metadata-only | fetch `photo_url` and pass the image to the model as an image block so it can actually look at the sticker |

That last row is the big one: the SDK supports image input, so a production
reviewer would *see* the photo. This sample deliberately stays metadata-only so it
runs without your R2 bucket, and defers to `needs_human` when the photo would
decide the call.

---

# Going live: `review-live.ts`

`review.ts` (above) is the **learning** version — fixtures in, JSON files out.
`review-live.ts` is the **real** version: it reads pending rows from your Google
Sheet, looks at each photo, and writes verdicts back to the Sheet. Same agent
shape; only the two tools' implementations changed.

```
Google Sheet ──listPending──► [ agent loop ]──setStatus──► Google Sheet
 (status=pending)                  │                         (active/rejected/review)
                                   ├─ get_photo()        ← LOOKS at the sticker (vision)
                                   ├─ reverse_geocode()  ← verifies the coordinates
                                   └─ record_decision()  ← writes the verdict back
```

**Verdict → status** (must match `src/lib/stickers.ts`):

| verdict | status written | on the map? |
|---------|----------------|-------------|
| approve | `active` | ✅ visible |
| reject | `rejected` | hidden |
| needs_human | `review` | hidden, and out of the pending queue for a person |

### ⚠️ Runs as a Node process, NOT in your Worker

The Claude Agent SDK needs a Node runtime — it does **not** run inside a
Cloudflare Worker. So this is a script you run on a schedule: locally via `cron`,
or in CI (a GitHub Actions cron workflow), or any small box. It talks to the same
Apps Script webhook your Worker already uses.

### One-time setup

1. **Update the Apps Script.** `apps-script/Code.gs` now has two new actions
   (`listPending`, `setStatus`). In the Sheet: Extensions → Apps Script, paste the
   updated file, then **Deploy → Manage deployments → (existing deployment) → Edit
   → Version: New version → Deploy**. Do **not** create a *new* deployment — that
   changes the `/exec` URL and breaks live submissions.
2. **Fill in `.env`** (`cp .env.example .env`): your `ANTHROPIC_API_KEY` plus the
   same `SHEET_WEBHOOK_URL` / `SHEET_WEBHOOK_TOKEN` your Worker uses.

### Verify, then arm (do these in order)

```bash
# 1. Vision probe — confirm the agent can actually SEE a photo (uses 1 real URL).
#    PASS = it describes the image; FAIL = "NO IMAGE RECEIVED".
npm run probe -- "https://YOUR-DOMAIN/photos/sightings/<some-uuid>.jpg"

# 2. Dry run — reviews real pending rows and PRINTS verdicts, writes NOTHING.
#    DRY_RUN defaults to true, so this is safe.
npm run review:live

# 3. Arm it — once you trust the verdicts, set DRY_RUN=false in .env and re-run.
#    NOW approvals go live on the map.
npm run review:live
```

### Scheduling it (optional)

Once you trust it, run it on a schedule. Simplest local option:

```cron
# every 15 min — review the pending queue (note: needs the env loaded)
*/15 * * * * cd /path/to/examples/submission-reviewer-agent && npm run review:live >> /tmp/reviewer.log 2>&1
```

For a hosted option, a GitHub Actions cron workflow with the secrets set works the
same way. Keep a human glancing at the `review` (deferred) rows.

## Files

- `review.ts` — the **learning** agent: fixtures → JSON files (start here)
- `review-live.ts` — the **real** agent: Google Sheet → Google Sheet, with vision
- `probe-vision.ts` — one-off test that the agent can see tool-returned photos
- `submissions.json` — three fake pending submissions (for `review.ts`)
- `.env.example` — copy to `.env` for the live version
- `decisions/` — verdicts `review.ts` writes (git-ignored)
