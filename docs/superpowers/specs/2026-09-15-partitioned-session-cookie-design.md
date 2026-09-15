# Partitioned session cookie for cookie-blocked LMS frames (#286)

Follow-on to #217 / #285. Status: implemented on `fix/lti-partitioned-session-cookie` (RED-first; Mongo + Firestore legs).

## Problem

With third-party cookies blocked, a cross-site LMS frame (Canvas, WileyPLUS, D2L)
cannot store trinket's `session` cookie, so every launch that lands on a
session-backed page fails after the launch itself succeeds:

- student assignment launch → course SPA + `assignment-embed` iframe
- SpeedGrader review launch → `/lti/review-panel` + feedback / view-only iframes

Both fall through to the `lti/framed-cookies.html` guidance page (464d46c).
The deep-link picker was fixed separately (#285) with a signed context token
because it needed no identity; these pages do.

## Decision

Use the `Partitioned` cookie attribute (CHIPS) instead of a signed identity token.
Chrome 114+, Edge, Firefox 141+, Safari 26.2+ honour it, and Chrome sends
partitioned cookies even when the user has blocked third-party cookies
(privacysandbox.google.com/cookies/chips). The token design in #286 stays on
file for if logs ever show meaningful pre-26.2 Safari traffic in frames.

### Why a copy, not an attribute

A cookie with `Partitioned` is *only* visible inside the partition (top-level
site) that set it. Marking the existing session cookie partitioned would
therefore sign a student out when they open trinket in a new tab from inside
the LMS frame — a flow that works today wherever third-party cookies are
allowed (most Chrome users; Google did not deprecate them). So the plain
cookie is untouched and a second `Set-Cookie` carries the same encrypted value
with the same attributes plus `Partitioned`.

### Why the SAME name

Firebase Hosting forwards exactly one cookie, `__session`, to a Cloud Run
rewrite and strips every other name at the edge. mandi and the Hosting-fronted
trial (`trinket-merge-test.web.app`, where the live test runs) set
`plugins.session.name: __session`; a differently named copy would never reach
the app there. So the copy keeps the session cookie's name.

A partitioned and an unpartitioned cookie of one name live in separate jars;
Chrome stores both and sends BOTH in the `Cookie` header, and treats that as
working as intended (crbug 41492918, Won't Fix — overwriting across jars would
be a tracking vector). hapi would parse the duplicate as an array and yar would
fail, so an `onRequest` extension collapses repeated `name=` cookies to the
FIRST before hapi's state step (hapi lifecycle: onRequest → state).

Which one is first: browsers order same-path cookies by creation time and keep
the original creation time when a cookie is replaced (RFC 6265 §5.3), so the
plain cookie — created first, or in the same response ahead of the copy — comes
first. The two are set together with identical values anyway; they can differ
only after a later non-framed response (an XHR from inside the frame) re-sealed
the plain one, and then the plain one is the fresher of the two.

### When the copy is emitted

On responses to any **navigation into a frame** (`Sec-Fetch-Dest: iframe|frame`):
the LTI launch (cross-site) and every page the framed app navigates to after it
(same-origin, but still inside the LMS frame, where only the partitioned jar is
writable when third-party cookies are blocked — including an in-frame sign-in
or the guidance the auth scheme gives a stale user). Top-level navigations and
fetches never emit it, so no partitioned cookie is created in a first-party jar
to go stale against the plain one, and today's users see today's headers.
XHR responses from inside a frame (`Sec-Fetch-Dest: empty`) set only the plain
cookie; where that is refused, the partitioned one from the last page load
persists, so at worst a flash message set by an API call is lost.

The rewrite happens on `request.raw.res.setHeader`, installed in the same
`onRequest` extension. hapi writes every response's headers there
(`transmit.js` `writeHead`), including a takeover from the Boom hook and a Boom
that hapi wraps itself — the previous `response._header` patch missed both.

Browsers that do not know `Partitioned` ignore the attribute and keep using the
plain cookie. Old Safari still blocks both in a frame and still gets the
guidance page.

## Components

- `lib/util/sessionCookie.js` (new, pure):
  - `partitionedCopies(setCookieValues, name)` → for each `name=` entry not
    already partitioned, the same entry with `; Partitioned` appended.
  - `wantsCopy(headers)` → the navigation-into-a-frame predicate.
  - `dedupe(cookieHeader, name, onConflict)` → the header with repeated
    `name=` cookies reduced to the first; the identical object when nothing
    changes; `onConflict` reports a dropped value that differs.
- `app.js`: one `onRequest` ext replaces the old `onPreResponse` header patch —
  it dedupes `request.headers.cookie` (logging a differing drop) and wraps
  `request.raw.res.setHeader` to add Expires (on `cookie: true` routes, as
  before) and the partitioned copies (when `sessionSecure && wantsCopy`).

## Tests (RED first)

Unit (`test/lib/util/sessionCookie.test.js`): copy only the session entry,
same name, `Partitioned` once, already-partitioned entries skipped, cleared
cookies copied too; `wantsCopy` true only for cross-site iframe/frame; `dedupe`
keeps the first, returns the same object otherwise, ignores look-alike names,
works for `__session`.

Integration (`test/lib/api/session-cookie-partitioned.test.js`, app inject):
- a cross-site framed sign-in sets the session cookie twice, plain then the
  same value with `Partitioned`; a top-level sign-in sets it once, unpartitioned.
- the partitioned copy alone is a valid session; both jars together are
  signed in; when they differ the first wins.
- a fetch from inside the frame emits no copy; a same-origin page navigation
  inside the frame does; logout in the frame clears both jars with the
  `cookie: true` Expires on both; a Boom-rendered 403 page in the frame still
  carries the copy (raw-response patch).
- the framed no-cookie guidance still renders.

Live: Steve's cross-site Canvas run on the web.app trial with cookies blocked —
student assignment launch renders and autosaves; SpeedGrader review panel
renders and feedback sends; and, with cookies ALLOWED, a framed launch still
works (both jars sent through Hosting). Then trials → uindy → mandi.

## Out of scope

- Signed identity launch token (kept in #286 as the fallback design).
- Any change to #285 (proven live, ready for review).
- `__Host-` prefixing or a hapi/statehood upgrade to get a native
  `isPartitioned` option (statehood 7 lacks it; the header patch already exists).
