# Legacy-shortcode redirect endpoint — design

**Date:** 2026-06-24
**Status:** Approved (pending spec review)

## Problem

People have saved links and embed codes (iframes) pointing at the **old** trinket
server. Those links use the old server's **shortcode**. When trinkets were imported
into the new server, the old code was preserved on each record as `legacyShortCode`,
but nothing resolves an old code to its new URL — so an old link/embed pointed at the
new server 404s.

We want a way to systematically convert an old shortcode into the correct **new** URL.

## Approach

A **dedicated** redirect endpoint that resolves a trinket **strictly** by its
`legacyShortCode` and issues a `301` redirect to the canonical new URL.

### Why a dedicated endpoint (not a fallback in the existing routes)

The obvious-looking alternative is to fold a legacy fallback into the normal
`/embed/{lang}/{code}` and `/{lang}/{code}` routes. We rejected that because of a
**namespace collision** risk:

- New-server shortCodes are 12-char hex; legacy codes come from a different system.
- A true collision is unlikely but not impossible.
- In a fallback model the current-shortCode lookup always wins, so a legacy code that
  happened to equal a live trinket's current shortCode would **silently serve the
  wrong trinket** — no error, just wrong content.

A dedicated endpoint queries **only** `legacyShortCode`, so it never overlaps the
live-shortCode namespace. There is no ambiguity.

The cost — editing the URL path — is free in practice: the old link names the **old
domain**, so whoever migrates a link/embed has to edit the URL anyway. Changing the
path at the same time is zero extra burden.

> **Out of scope / caveat:** this endpoint fixes the **shortcode**, not the
> **hostname**. For an old request to reach the new server at all, either the old
> domain must resolve to the new server or the editor must swap the domain. That is an
> ops concern, not a code concern.

## Endpoints

Public, no auth (mirrors the existing embed/page routes). Added to `config/routes.js`.

| Route | Redirects to |
|-------|--------------|
| `GET /legacy/{shortCode}`       | `/{lang}/{newShortCode}`       (the trinket page) |
| `GET /legacy/embed/{shortCode}` | `/embed/{lang}/{newShortCode}` (the iframe embed) |

- `{shortCode}` is the **old** code. Validated as a required Joi string param, mirroring
  the existing trinket routes.
- No `lang` in the request: the legacy code resolves the record, and `lang` +
  `shortCode` for the target are read **from the record itself**.

## Handler logic

Two thin actions in `lib/controllers/trinket.js` (`legacyRedirect`,
`legacyEmbedRedirect`) sharing one private helper:

1. `Trinket.findByLegacyShortCode(request.params.shortCode)` — already exists
   (`lib/models/trinket.js`, returns a single doc via `findOne`).
2. **Found and not soft-deleted** → `reply().redirect(target).permanent()` (301),
   where `target` is built from the record:
   - page:  `/` + `trinket.lang` + `/` + `trinket.shortCode`
   - embed: `/embed/` + `trinket.lang` + `/` + `trinket.shortCode`
3. **Not found, or `deletedAt` is set** → `Boom.notFound()` (404).

No model changes are required.

## Decisions

- **301 (permanent), confirmed.** The legacy→new mapping is stable, so a permanent
  redirect is correct and lets browsers/crawlers cache it. Accepted tradeoff: browsers
  cache 301s aggressively, so a wrong redirect is painful to undo — acceptable because
  the mapping does not change.
- **Lang is read from the record.** Old `vpython` / `webvpython` / `r` codes therefore
  land on their renamed `glowscript` / `R` types automatically — the rename is fixed
  for free.
- **Duplicate legacy codes.** `legacyShortCode` is indexed **sparse, not unique**, and
  `findByLegacyShortCode` is `findOne`. If an import ever produced two trinkets with the
  same legacy code we resolve to whichever Mongo returns first. Handling: **log a
  warning** in that case but still redirect. Accepted as a low-probability edge case.
- **Soft-deleted trinkets** return 404, consistent with the existing `findTrinket`
  pre-handler.

## Testing

Integration tests against the routes:

1. Known legacy code → `301` with correct `Location: /{lang}/{newShortCode}`.
2. Embed variant → `301` with `Location: /embed/{lang}/{newShortCode}`.
3. Unknown legacy code → `404`.
4. Soft-deleted trinket (legacy code present but `deletedAt` set) → `404`.
5. Lang-rename case: a legacy `vpython` code resolves to a `glowscript` record →
   `Location` uses `/glowscript/...`.

## Scope

Two routes, two small handlers, one shared private helper, zero model changes. No
changes to the existing embed/page/download routes.
