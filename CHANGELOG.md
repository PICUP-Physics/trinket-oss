# Changelog

All notable changes to this project will be documented in this file.

Entries are grouped by who notices them. Numbers in parentheses are pull
requests in this repository. A user-facing version of this list lives at
`/whats-new` on a running site (`lib/views/static/whats-new.html`) — keep the
two roughly in sync when adding a release.

## [Unreleased] — since the initial open source release

### Writing and running code

- **Web VPython programs can be stopped.** While a program runs, Run turns into
  a red Stop with a strip lapping its edge; Stop freezes the scene where it
  stands (it can still be rotated and zoomed), and the button returns to Run,
  as it also does when a program finishes on its own (#336).
- **Python runs real CPython in the browser** via Pyodide, so `numpy`,
  `matplotlib` and true language semantics work instead of the previous
  Skulpt approximation (#12). The New Trinket menu shows a single **Python**
  entry rather than three overlapping variants (#16).
- **`input()` works in Python trinkets.** It previously raised
  `OSError: [Errno 29] I/O error` the moment a program read input, which broke
  any exercise using it (#81).
- **Variable explorer** — a Variables tab listing the names your program
  defines, with expandable nested lists, dicts and objects (#17, #42).
  Off by default: `features.variableExplorer`.
- **Step-through debugger** — record & replay stepping for Python trinkets:
  step forward *and backward*, scrub with a slider, "called from line N"
  breadcrumbs, multi-file stepping, changed-variable highlighting, and
  gutter breakpoints with next/previous-breakpoint navigation
  (#43, #44, #49). Off by default: `features.stepDebugger` (requires
  `features.variableExplorer`).
- matplotlib plots no longer clip their axis labels (#18).
- The GlowScript/VPython canvas resize grip is visible and functional (#14).
- Code/output/stdio dividers are draggable by touch on iPad (#65).
- Pyodide trinkets get the same embed/display options as python3 (#67).
- Anonymous fork/share is configurable — `features.requireAuthToFork` (#29).

### Courses

- **The Publish dialog opens.** The `#publishModal` markup was missing from the
  open source release, so Publish and the "Click to Publish" tile silently did
  nothing (#52).
- **My Courses** page and navigation links (#39).
- **Bulk trinket management** — multi-select move/delete, filters, date-range
  selection (#56, #59).
- **Course deletion** is discoverable from the Course menu (#54).
- **Download Student Work** — export student submissions together with
  instructor feedback (#96).
- **Roster management** — existing accounts are enrolled on login, and
  Add-Students handles classroom-scale rosters (#94).
- **Join-by-access-code** self-service enrollment (#88). Off by default:
  `features.accessCodeEnrollment`.
- Course-page file uploads work, including after a hard refresh (#13, #20, #33).
- The course markdown editor loads its Ace mode and theme instead of 404ing
  them (#34).
- **Large course archives** upload directly to storage rather than hitting the
  request size ceiling (#92). Configurable via `imports.largeUpload`; requires a
  browser-reachable storage endpoint.
- The Featured Courses column no longer disappears from the home page (#93).

### Migrating from trinket.io

- Old trinket.io short links redirect to the equivalent trinket here (#11).
- Imported course embeds are rewritten to this host instead of quietly loading
  trinket.io's interface — including shortcode-less sandbox embeds (#57).
- Legacy trinket.io "python" trinkets are stored as `python3` on import, with a
  migration for trinkets imported before the fix (#81). Python-2 syntax is
  flagged rather than silently converted.
- Trinkets open whether stored as `python3` or `pyodide` (#31).
- Import de-duplication is scoped to the importing user and ignores
  soft-deleted trinkets (#40, #53).

### Accounts and links

- **Login rate limiting counts only failed attempts**, so a classroom behind one
  IP is no longer locked out (#30), using the rightmost `X-Forwarded-For` (#22).
- Returning users no longer see "Your account has been created" on every
  login (#79).
- Signing up with an existing address shows a real message instead of a 404 (#90).
- Renamed courses and trinkets redirect (301) instead of 404ing on the old
  URL (#69, #85).
- Published trinket URLs derive from the current host (#32), and trinkets
  created while signed in are correctly owned rather than orphaned (#36).

### Reliability

- Fixed the course-page save conflict that could OOM and crash-loop the server,
  plus the stale-content variant behind persistent "modified in another window"
  conflicts (#60, #64).
- Closed a class of bugs where handlers returned an empty body or a 500 that
  silently emptied a list (#63, #91, #93).
- "Download All" excludes soft-deleted trinkets (#71).
- Sessions, LTI nonces and error telemetry expire instead of growing without
  bound (#77). **Note:** has manual post-deploy steps — see the PR.
- Services restart automatically after a daemon restart or host reboot (#48).

### Deployment and branding

- Config-driven branding: theme colors (#19), landing page text (#25),
  New Trinket menu labels (#50), and a site-wide announcement banner (#82).
- **Per-deploy overlay** (`deploys/<name>/`) so a deployment's configuration,
  views and assets live in their own private repository instead of local
  patches (#83).
- LMS/LTI integration and a Firestore / Firebase Auth / Cloud Run deployment
  option (#45), with LTI registration and launch fixed on the MongoDB
  backend (#76).
- Per-deploy secrets are kept out of the image build (#68).
- Playwright browser smoke suite for client-side golden paths (#84).

## [1.0.0] - Initial Open Source Release

First public release of Trinket.
