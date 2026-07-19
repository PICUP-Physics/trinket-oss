'use strict';

// Rewrite trinket embed iframes inside imported course material so they point at
// THIS server instead of trinket.io. Two shapes exist:
//   • shortcode embeds  (/embed/{lang}/{shortCode}) → map the old shortCode to
//     the importing user's new one.
//   • sandbox embeds    (/embed/{lang}, NO shortCode) → rewrite just the host.
// The shortcode-less case used to match no pattern, so those embeds kept loading
// from trinket.io on a self-hosted instance (picup issue #51).

// Group 1 = full iframe tag, group 2 = lang, group 3 = shortCode (OPTIONAL — a
// sandbox embed has none).
var TRINKET_EMBED_RE = /(<iframe[^>]+src=['"][^'"]*\/embed\/(\w+)(?:\/([a-f0-9]{8,12}))?[^'"]*['"][^>]*>)/gi;

// The shortCode portion of an embed src URL (any host); used to swap in the new
// shortCode for a resolved ref. Group 1 = lang, group 2 = shortCode.
var EMBED_URL_RE = /https?:\/\/[^\/'"]+\/embed\/(\w+)\/([a-f0-9]{8,12})/;

// The host + /embed/{lang} prefix of an ABSOLUTE embed src (no shortCode). Only
// absolute URLs carry a host to swap; a relative /embed/{lang} is already local
// and left untouched. Idempotent: rewriting a URL already on baseUrl yields the
// same string, so the two rewrite passes never double-rewrite. Group 1 = the
// /embed/{lang} path we keep.
var EMBED_HOST_RE = /https?:\/\/[^\/'"]+(\/embed\/\w+)/;

// Rewrite every trinket embed in `content`. Returns { content, unresolved }
// where `unresolved` lists shortCodes with no mapping (the caller may record
// them for a later patch pass).
function rewriteTrinketEmbeds(content, legacyMap, baseUrl) {
  legacyMap = legacyMap || {};
  var unresolved = [];

  var out = (content || '').replace(TRINKET_EMBED_RE, function(full, iframeTag, lang, shortCode) {
    if (!shortCode) {
      // Sandbox embed (no shortCode): swap the host on absolute trinket.io URLs.
      return iframeTag.replace(EMBED_HOST_RE, baseUrl + '$1');
    }
    if (legacyMap[shortCode]) {
      return iframeTag.replace(EMBED_URL_RE, baseUrl + '/embed/' + lang + '/' + legacyMap[shortCode]);
    }
    if (unresolved.indexOf(shortCode) < 0) unresolved.push(shortCode);
    return full;
  });

  return { content: out, unresolved: unresolved };
}

module.exports = {
  TRINKET_EMBED_RE: TRINKET_EMBED_RE,
  EMBED_URL_RE: EMBED_URL_RE,
  EMBED_HOST_RE: EMBED_HOST_RE,
  rewriteTrinketEmbeds: rewriteTrinketEmbeds
};
