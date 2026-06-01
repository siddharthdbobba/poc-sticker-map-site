---
description: Security sweep of the codebase — find and (optionally) fix vulnerabilities
argument-hint: "[area to focus on, e.g. 'the submit route' — optional]"
---

Act as a senior application-security engineer reviewing this repository. $ARGUMENTS

Scope your review to the real attack surface of this app (an Astro site on Cloudflare Workers with public photo submissions):

1. **Untrusted input → server routes.** Scrutinize `src/pages/api/submit.ts` and `src/pages/photos/[...key].ts`: file-upload validation (magic-byte sniffing vs. declared content-type, SVG/HTML/script payloads, size limits, decompression/zip-bomb risk), path/key injection into R2, SSRF or injection into the Apps Script webhook, and error paths that could orphan data or leak internals.
2. **Secrets & bindings.** Confirm no secret is referenced outside `locals.runtime.env` / `cloudflare:workers` env, nothing secret reaches the client bundle, and `PUBLIC_*` vars truly contain nothing sensitive.
3. **Client-side.** XSS via rendered sheet/user content (descriptions, names, photo URLs) in the Leaflet popups and the submit form; unsafe `innerHTML`/`dangerouslySetInnerHTML`; open-redirect or tainted URLs.
4. **Auth/abuse.** The submission endpoint is unauthenticated by design — assess rate-limiting / bot-abuse exposure (Turnstile is planned) and the "raw photo URL reachable before approval" caveat.
5. **Config.** `wrangler.jsonc`, `astro.config.mjs`, CORS, and any headers worth hardening.

For each finding, report: **severity** (critical/high/medium/low), the exact `file:line`, why it's exploitable (concrete attack), and the minimal fix.

After listing findings, **stop and show me the report**. Only apply fixes if I confirm, or if I explicitly asked you to fix in the command above — and when you do, fix highest-severity first and keep each change minimal and reviewable.
