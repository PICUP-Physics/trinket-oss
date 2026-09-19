# Pyodide Worker Runtime — Design

**Issue:** [#108](https://github.com/PICUP-Physics/trinket-oss/issues/108) — a running program can freeze the tab, and Stop cannot always stop it.

**Goal:** Run student Python off the main thread so the page never freezes, and so Stop can halt *any* program — including `while True: pass`.

**Architecture:** A routed dual runtime. A pre-flight step inspects each program and chooses between today's in-window Pyodide (unchanged) and a new Web Worker kernel. The worker never touches the DOM; everything it needs from the page crosses a single typed message channel.

**Tech stack:** Pyodide (existing), Web Workers, `postMessage`. No `SharedArrayBuffer` — see [Constraint 1](#global-constraints).

---

## Global Constraints

These bind every task in the implementation plan.

1. **No `SharedArrayBuffer`.** `SAB` + `Atomics.wait` is the usual way to make worker input synchronous, and it requires cross-origin isolation. An iframe is only `crossOriginIsolated` if the **top-level page** is, so trinket embeds — the primary delivery vehicle — can never have it. Every design decision below assumes an asynchronous channel.
2. **No regression for VPython.** Web VPython / GlowScript is the feature this project's users depend on most (Matter & Interactions courses). v1 does not change how it executes.
3. **The worker never touches the DOM.** No `document`, no `window`, no direct GlowScript calls. Anything visual crosses the channel as a message.
4. **Existing output handling is reused, not reimplemented.** Tracebacks go through `formatPythonTraceback()` and `escapeConsoleHtml()` in `public/js/embed/pyodide.js`; console writes go through `writeOut()`.
5. **Opt-in until proven.** Ships behind a query parameter and a config flag, both default off.
6. **Message type names are fixed by this spec.** Use the exact strings in [Protocol](#4-protocol), including the reserved ones.

---

## 0. Dependencies and starting point

This design is written against **`smoke/phase1-2`**, not `picup/main`. Three symbols it reuses do not exist upstream yet; they are in open PRs:

| Symbol | Where it lives now | PR |
|---|---|---|
| `formatPythonTraceback()` | `fix/107-traceback-noise` | #117 |
| `escapeConsoleHtml()` | both #117 and #114 (defined in each) | #117 / #114 |
| REPL (`startRepl`, `consoleResult`, run-options menu) | `spike/109-pyodide-repl` | #114 |
| `SLEEP_CANCEL_CODE`, `stop-it` button | `feat/108-vpython-stop-clean` | #122 |

**Sequencing consequence:** implementation should start only after those merge, or on a branch that already contains them. Starting from `picup/main` would mean reimplementing traceback formatting and console escaping, and `escapeConsoleHtml` is currently duplicated across #114 and #117 — that duplicate must be resolved to a single definition when they land, before this project builds on it.

`usesVPython()` exists in all of them.

---

## 1. Problem, with evidence

Pyodide runs CPython compiled to WASM **synchronously on the main thread**, and WASM cannot be preempted. Measured in an embed:

| Program | Tab | Stop |
|---|---|---|
| `while True: print('.'); time.sleep(1)` | responsive | works |
| VPython loop with `rate(30)` | responsive | works |
| `while True: print('.')` | **frozen** | impossible |
| `while True: pass` | **frozen** | impossible |

Cancellation today is cooperative: `SLEEP_CANCEL_CODE` wraps `time.sleep` and `installRateCancellation()` wraps `rate`, each raising when a stop is requested. Both work only where the program *yields*. A loop with no yield point gives the page no opportunity to run, so the Stop button cannot even be clicked.

A worker fixes this by construction: execution is not on the UI thread, and `worker.terminate()` is unconditional.

---

## 2. Decisions

Settled during design; recorded with rationale so the plan doesn't relitigate them.

| # | Decision | Rationale |
|---|---|---|
| D1 | Off-main-thread execution, not just better cancellation | The goal is "the page never freezes", not only "Stop works". An AST-injected cancellation check would fix Stop while leaving the tab stuttering. |
| D2 | VPython stays on the main thread in v1 | Its bridge binds `from js import sphere, box, rate, …` synchronously to the window realm. Moving it is a *replacement*, not a port. **Still holds for v1, but the rationale is superseded — see §14-16: the replacement is an existing package, and the current bridge cannot be moved off-thread in an embed at any price.** |
| D3 | Programs the transform can't handle fall back to the main thread | Preserves today's behaviour instead of failing a program that works now. |
| D4 | matplotlib uses `backend_webagg_core` over `postMessage` | The `ipympl` architecture, which is how JupyterLite and VS Code get interactive figures from an out-of-process kernel. Keeps pan/zoom. **Implemented and verified — but see §8 for what this section got wrong about Pyodide.** |
| D5 | Interactive 3D in the worker is the committed destination; the channel is shaped for it now | Reserving the message types costs nothing today and keeps the later bridge additive rather than a transport rewrite. |
| D6 | Variable explorer and step debugger run in the worker too, not routed away | Both already serialise to JSON and are only read when Python is idle, so they port as a transport change with no logic change. An earlier draft routed them to the main thread, which would have disabled worker coverage site-wide for any deploy that enabled the explorer. |

**Explicitly not decided here:** how the VPython bridge itself is replaced. That is its own spec — see [Non-goals](#10-non-goals-and-what-comes-next).

> **Read §14, §15 and §16 before acting on D2 or D5.** Those sections record the
> proposal to adopt `vpython-jupyter` instead of replacing the bridge ourselves,
> the correction to the GlowScript lineage, and the evidence that decides it. They
> change the *reasoning* behind D2 and D5, not the v1 scope.

---

## 3. Architecture — a routed dual runtime

The unit of decision is a **program**, not the site. Before running, `runtime-router.js` picks a runtime:

```
                    ┌─────────────────────────┐
   program source → │  chooseRuntime(source)  │
                    └───────────┬─────────────┘
                      'main'    │    'worker'
              ┌─────────────────┴───────────────┐
              ▼                                 ▼
   today's in-window Pyodide          pyodide-worker.js
   (VPython bridge, webagg)           (no DOM; messages only)
    Stop = cooperative                 Stop = terminate()

   variable explorer + step debugger work in BOTH:
   their payloads are already JSON (see 8a)
```

### Routing rules

Applied in order; the first match wins.

| Rule | Runtime | Reason |
|---|---|---|
| `usesVPython(source)` — already implemented in `public/js/embed/pyodide.js` | `main` | D2 |
| `input()` / `rate()` / `sleep()` inside a `lambda` or comprehension | `main` | `await` cannot be inserted there (documented in `_async_transform.py`) |
| `?runtime=main` | `main` | escape hatch |
| otherwise | `worker` | the common case |

`chooseRuntime()` is a **pure function of (source, config, query)** returning `'main' | 'worker'` plus a `reason` string for diagnostics. Pure means it is unit-testable in node with no browser and no Pyodide — the only part of this project that can be tested cheaply, so it carries the routing logic rather than letting it smear into `pyodide.js`.

---

## 4. Protocol

One channel, typed messages, versioned with a `v` field so a stale cached worker can be detected and replaced.

### page → worker

| Type | Payload | Notes |
|---|---|---|
| `init` | `{ v, pyodideUrl, indexURL, varsHelper, displayUrl }` | once per worker. `packages` was in this row and has never been sent — the implementation posts `indexURL` (`worker-client.js`), and packages are loaded per run from the program's imports. `displayUrl` is `_trinket_display.py` for `features.mathOutput` (#288) — empty string when the flag is off, and the worker then fetches nothing |
| `run` | `{ id, source, files }` | `id` correlates every reply |
| `stdin-reply` | `{ id, value }` | answers `input-request` |
| `mpl-event` | `{ figureId, event }` | mouse/zoom into webagg |
| `scene-event` | `{ idx, event }` | **reserved, not implemented in v1** (D5) |

### worker → page

| Type | Payload | Notes |
|---|---|---|
| `ready` | `{ v, pyodideVersion }` | boot finished |
| `stdout` / `stderr` | `{ id, text }` | line-batched, as today |
| `input-request` | `{ id, prompt }` | worker suspends until answered |
| `figure` | `{ id, figureId, kind: 'diff'\|'png', data }` | webagg diff or PNG fallback |
| `rich` | `{ id, json }` | one typeset result (#288). Streaming and UNSCOPED, like `stdout`: the page queues cards and program text in one buffer, so program order survives only if both are delivered in post order |
| `done` | `{ id }` | run finished normally |
| `error` | `{ id, traceback }` | raw traceback string; page formats it |
| `scene-ops` | `{ ops: [...] }` | **reserved, not implemented in v1** (D5) |

Reserved types are defined but never sent in v1. A v1 worker that receives `scene-event` replies `error` with "not supported in this runtime version" rather than failing silently.

---

## 5. Stop

For worker-routed programs, Stop is `worker.terminate()` — immediate, unconditional, and correct for `while True: pass`. The page then:

1. marks the in-flight run cancelled and writes `[stopped]` to the console,
2. hides the Stop button,
3. spawns a replacement worker **lazily** — on next Run, or during idle after a short delay, so a student who stops and immediately re-runs doesn't wait for a cold Pyodide boot.

Cooperative cancellation (`SLEEP_CANCEL_CODE`, `installRateCancellation`) remains, unchanged, for the main-thread path. The two mechanisms never both apply to one run.

**Cost:** terminating discards the Python namespace. This is correct for Run (each run already starts clean) but matters for the REPL — see [§7](#7-the-repl).

---

## 6. `input()` without SharedArrayBuffer

`_async_transform.py` already promotes enclosing functions to `async def` and propagates `await` to callers transitively; `console.input()` is already in its namespaced await set. The worker path extends this:

1. Transform rewrites `input(...)` to an awaited call.
2. Worker posts `input-request` and suspends on a promise.
3. Page prompts through jqconsole — the same widget `console.input()` uses today — and posts `stdin-reply`.
4. Worker resolves the promise; the program continues.

If the prompt is cancelled (a new Run, or Stop), the worker is terminated, so no reply is needed.

Programs where the transform cannot insert `await` never reach the worker — they were routed to the main thread ([§3](#routing-rules)).

---

## 7. The REPL

The #109 REPL moves to the worker. Each submitted statement is a `run` message against a persistent namespace held in the worker.

This removes the REPL's one documented limitation: an infinite loop typed at the prompt currently freezes the tab with no recovery but reload.

**Explicit consequence:** stopping a runaway REPL statement terminates the worker and therefore **loses the session's variables**. The page states this plainly when it happens (`[stopped — console session reset]`) rather than letting a student wonder why `x` disappeared. Preserving a namespace across termination is not possible and is not attempted.

---

## 8. matplotlib

**Status: implemented and verified** (interactive figures, full toolbar).

`backend_webagg_core` emits frames and consumes events; matplotlib's own
`mpl.js` renders them on the page; `postMessage` replaces the WebSocket:

```
worker                                   page
------                                   ----
backend_webagg_core   ──{figure diff}──▶  mpl.js → canvas
handle_json(event)    ◀──{mpl-event}───   mouse / zoom / toolbar
```

### What this section originally got wrong

The design asserted that `backend_webagg_core` is transport-agnostic. That is
true upstream and **false in Pyodide**, whose matplotlib patches it. Recorded
here because every one of these cost a debugging round, and anyone revisiting
this will hit them again:

1. **It imports the DOM at module load** — `from js import alert, document`. The
   DOM is used only by its download helper, so inert stubs in the worker satisfy
   the import and lose nothing; saving happens page-side from the canvas.
2. **`mpl.toolbar_items` and `mpl.extensions` are not in `mpl.js`.** They are
   appended by `FigureManagerWebAgg.get_javascript()`. Reading `mpl.js` off disk
   gives a toolbar with **no buttons**.
3. **Toolbar icons come from the embedder.** Pyodide's `mpl.js` calls
   `mpl.toolbar_image_callback(name).toJs({create_pyproxies:false})` and expects
   a PyProxy of bytes. The icons ship from the wheel as base64; a plain object
   with a `.toJs()` satisfies it.
4. **Its `mpl.js` hands the socket an object**, not a JSON string.
5. **Nothing pumps the event loop.** Upstream Tornado drives `refresh_all()`;
   in a worker nothing does, so both the first frame and every post-event redraw
   must be pumped explicitly. Without this the figure renders and then never
   responds — the failure looks like a dead bridge but is a missing pump.

### Ordering

The figure is announced to the page **before** `add_web_socket`. That call starts
sending immediately and `postMessage` preserves order, so attaching first
delivers frames for a figure the page has not yet created, and they are dropped.

### Sizing

The worker cannot see the page. Pyodide's manager ignores `mpl.js`'s `resize`
message (the same gap as `supports_binary`), so the default figure size is set in
Python from a pane width sent with the run. Note the graphic pane is still hidden
at that moment, so the width must be measured from a visible ancestor.

### Fallback

If `mpl.js` fails to load, the worker sends a static PNG on the same `figure`
message and the page renders an `<img>`. A plot always appears.

### Testing note

Automated synthetic `MouseEvent`s put correctly-mapped coordinates on the wire
but do **not** trigger a redraw — `mpl.js` appears to require trusted events. The
render, sizing, toolbar and canvas ink are asserted in the browser spec;
zoom-to-rectangle is verified by hand. Do not read the absent assertion as an
absent feature.

## 8a. Variable explorer and step debugger over the channel

An earlier draft routed these to the main thread. That was wrong, and it mattered:
both flags are *site* config, so the rule would have disabled worker coverage
entirely for any deploy that enabled the explorer. Reading the implementation
shows neither feature needs the main thread.

**Both are already JSON at the boundary.** `VARS_HELPER` and `RECORD_HELPER` each
end in `json.dumps(...)`, and the JS side does a single `JSON.parse` — a comment
at `pyodide.js:551` says so outright ("the JS side does a single JSON.parse and
never juggles PyProxy lifetimes"). Nothing live crosses the boundary today, so
nothing live needs to cross the channel.

**Both are needed only when Python is idle**, which is what makes this work:

| Feature | When it reads state | Payload |
|---|---|---|
| Variable explorer | **post-run only** — one call site, on success and on error | array of `{name, kind, type, value, …}` |
| Step debugger | **once, after the run** — the recorder returns the whole run | `{error, truncated, armed, skipped, output, steps, snaps}` |
| Lazy tree expansion | on click, after the run | one expanded node |

The worker's message loop is blocked *while Python runs*, exactly as the main
thread is today — but neither feature asks for anything during a run, so the
block is irrelevant. Live mid-run inspection is not a feature today and is not
added here.

### Added messages

| Direction | Type | Payload |
|---|---|---|
| page → worker | `snapshot` | `{ id }` — request the post-run namespace |
| page → worker | `record` | `{ id, source }` — run under the step recorder |
| page → worker | `expand` | `{ id, path }` — expand one tree node |
| worker → page | `snapshot-result` / `record-result` / `expand-result` | `{ id, json }` |

The worker runs the **same** `VARS_HELPER` / `RECORD_HELPER` source, unmodified.
`renderVariables()` and the replay UI on the page are unchanged — they already
consume parsed JSON and cannot tell which runtime produced it. This is the
cheapest kind of port: a transport change with no logic change on either side.

### The one real behavioural difference

Stopping a worker program **terminates it**, so there is no post-run snapshot —
the Variables panel has nothing to show, and an already-rendered tree can no
longer expand, because the namespace it described is gone.

Today, stopping a program raises inside Python, the run completes as an error,
and the post-run snapshot still happens. So this is a genuine regression in one
narrow case, and it is the direct price of unconditional Stop. The page marks the
panel stale ("variables unavailable — the program was stopped") rather than
showing a silently empty or stale-but-unlabelled table.


## 9. Errors, tracebacks, and output

The worker sends the **raw** traceback string. All formatting stays on the page, reusing what already exists:

- `formatPythonTraceback(msg, mainName)` — strips Pyodide-internal frames (#107)
- `escapeConsoleHtml(text)` — prevents angle-bracketed names being eaten by the HTML parser, and prevents markup in an exception message from executing

The worker's frames differ from the in-window ones (no `pyodide.asm`, different paths), so `TRACEBACK_INTERNAL` is verified against real worker tracebacks and extended if needed — with a test per added pattern.

---

## 10. Non-goals, and what comes next

**Not in this project:**

- Replacing the VPython bridge. Today's `from js import …` bridge stays. Interactive 3D in the worker is the committed destination (D5), but it needs the vpython-jupyter-style protocol — proxy objects, compact per-attribute diffs keyed by object index, a browser-driven flush, and shadow state for reads (`obj._value = evt['value']`) — and that is a spec of its own. This design only guarantees the channel won't need rebuilding for it.
- Turtle graphics, `micropip`, and other DOM-touching packages — routed to the main thread by the same mechanism if they prove to need it.

**Why 3D is tractable later, recorded so it isn't re-argued:** GlowScript renders WebGL in the browser and owns camera interaction, so dragging a scene stays smooth *even while Python computes* — better than today, where a busy program freezes the scene. Only program-driven changes and bound handlers need a round trip, and `postMessage` is cheaper than the localhost WebSocket vpython-jupyter already ships interactively.

---

## 11. Testing

| Layer | What | How |
|---|---|---|
| `chooseRuntime()` | every routing rule, including precedence | node unit tests, no browser |
| Stop | `while True: pass` is killed; page stays responsive | Playwright, `test/browser/specs/` |
| `input()` | prompt round-trip; cancel mid-prompt | Playwright |
| matplotlib | figure renders; interaction works; PNG fallback | Playwright |
| REPL | statements persist; runaway stops with a clear reset message | Playwright |
| Regression | VPython, variable explorer, step debugger unchanged | existing specs, must stay green |

The routing predicate is the only cheaply-testable piece, which is exactly why it is a separate pure module. Everything else is genuine runtime behaviour and is tested in a browser against a live stack — consistent with how #107/#108/#109 were verified.

---

## 12. Rollout

1. Behind `?runtime=worker` and `config.features.workerRuntime` (default **false**).
2. Enabled on the trial servers; exercised against the manual smoke checklist.
3. Default flipped only after the trials are clean, and only for non-VPython programs.
4. `?runtime=main` remains permanently as an escape hatch.

**Success criteria:**

- `while True: pass` is stoppable, and the page stays responsive while it runs.
- No change in behaviour for VPython programs.
- `input()`, matplotlib, and the REPL work in the worker.
- Cold-start cost after Stop is not visible to a student who immediately re-runs.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Pyodide boot cost on every Stop | pre-warm a replacement worker during idle |
| ~~`mpl.js` / matplotlib version skew~~ **resolved** | `mpl.js` ships *inside* the Pyodide matplotlib wheel, so it is read from the very interpreter running the code. Skew is structurally impossible; no version assertion needed. |
| Routing misfires — a program silently loses freeze protection | `chooseRuntime()` returns a `reason`, surfaced in `/version`-style diagnostics and asserted in tests |
| Two runtimes drift apart | shared output formatting; regression specs run against both |
| Worker adds latency to short programs | measure; if material, keep short programs on the main thread by the same routing mechanism |

---

## 14. Addendum (2026-08-09) — adopt vpython-jupyter wholesale instead of porting our bridge

**Status: proposal, not decided. Nothing here is implemented.** Recorded because it
changes the economics of D2/D5 substantially, and because the reconnaissance
below is cheap to lose and expensive to redo.

### The idea

Steve's proposal: rather than incrementally moving today's Pyodide Web VPython
bridge off-thread, **drop it and adopt the `vpython-jupyter` package as-is**. It
already implements the whole object protocol — proxy objects, an object registry
keyed by index, compact per-attribute codes, a browser-driven flush, and
shadow-state reads. The work becomes "make it run under Pyodide and give it a
transport", not "reimplement the protocol".

### What the reconnaissance found

Checked against the clone at `~/Development/glow-repos/vpython-jupyter`:

| Concern | Finding |
|---|---|
| `cyvector.pyx` is Cython — needs a wasm build | **Not a blocker.** `_vector_import_helper.py` falls back to the pure-Python `vector.py` on `ImportError`. |
| Requires jupyter / ipykernel | **Not at import.** `ipykernel.comm` is imported lazily inside `GlowWidget.__init__` (`vpython.py:380`); `IPython.display` at :2908. `setup.py` lists them, but the core does not need them to load. |
| Core module pulls in heavy deps | **No.** `vpython/vpython.py` imports `colorsys`, `math`, `time`, `sys`, `atexit`, `inspect`, `platform` — stdlib only. |
| Transport is hard-wired | **No — there is already a seam.** `baseObj.__init__` selects one at runtime: `from .with_notebook import _` or `from .no_notebook import _` (`vpython.py:265-267`), and the module-global `sender` is just a send function. |

**That seam is the whole point.** The package already expects more than one
transport. A third — `trinket_worker`, whose `sender` posts on the #108 channel —
is the shape it is built for, and is far less code than replacing the protocol.

### What is NOT reusable

- **`no_notebook.py` is out.** It stands up an `http.server` and an `autobahn`
  websocket server in threads — none of which exists in a worker. It is a
  reference for the message shapes, not code to run.
- **`glowcomm.js` is Jupyter-specific.** Its first act is
  `IPython.notebook.kernel.comm_manager.register_target('glow', …)`. The browser
  half has to be rewritten against our channel — roughly 986 lines to read, far
  less to reimplement, since the useful part is the message handling.

### The open risk: GlowScript version alignment

> **Superseded by §15.** Written on the assumption that vpython-jupyter is a
> third-party dependency whose GlowScript we would have to accept. It is Steve's
> repository, and trinket *builds* the GlowScript both sides should use, so the
> alignment runs the other way. Left in place as the record of what was assumed.

Trinket loads `glow.3.2.2.min.js` and the webvpython `vpython.zip`;
vpython-jupyter ships its own `glow.min.js` (~575 KB) plus `gs_version.py`.
Adopting the package means adopting **its** GlowScript, or proving ours is
compatible with its protocol expectations. This is the most likely source of
subtle breakage and should be settled before any implementation.

### How this changes D2 and D5

- **D2** ("VPython stays on the main thread") was justified by the cost of
  replacing our `from js import sphere, box, rate, …` bridge. If the replacement
  is an existing, maintained package plus one transport, that cost drops sharply
  and D2 should be revisited.
- **D5** stands and gets easier: `scene-ops` / `scene-event` are already reserved
  on the channel, and vpython-jupyter's message shapes can define their payloads
  rather than us inventing them.

### Recommended next step

A **spike, not an implementation**: install the `vpython` package into Pyodide in
the worker, import it, and see how far it gets before it needs a transport. That
single experiment answers the version question and the import question together,
and it is a day's work rather than a project.

**Sequencing:** after #125 lands and the worker has run on the trials. Adopting a
new VPython implementation is the highest-risk change available to this codebase —
it touches the feature Matter & Interactions courses depend on most — and it
should not ride along with the runtime change.

---

## 15. Addendum (2026-08-09, later) — vpython-jupyter is ours to change, and the alignment runs the other way

**Status: still a proposal.** Two facts from Steve reframe §14 enough to be worth
recording separately rather than editing it away:

1. **`vpython-jupyter` is his repository.** It can be changed to make this work —
   it is not a third-party dependency to be accommodated.
2. **The ambition is larger than a transport.** vpython-jupyter has been stagnant;
   trinket is actively maintained. Marrying them gives the package a maintained
   home, and the same work is what makes vpython-jupyter run in **VS Code and
   Colab**, which is the outcome Steve is most interested in.

### The version risk inverts: trinket is a GlowScript *publisher*, not a consumer

§14 recorded "adopting the package means adopting **its** GlowScript" as the
likeliest source of breakage. That is backwards. The supply chain, read off the
build:

- `Dockerfile` fetches `glow.3.2.min.js`, `RScompiler.3.2.min.js`,
  `RSrun.3.2.min.js` from `https://storage.googleapis.com/rswvprunner/package`,
  installs them as `*.3.2.3.min.js`, and **verifies each against a pinned
  sha256** — an intentional republish upstream fails the build instead of
  silently shipping.
- Those artifacts are built from `~/Development/glow-repos/webvpython/rsWVPRunner`
  and pushed to GCS by `do_build.sh`; `scripts/setup-glowscript.sh` installs
  either the local build or the GCS copy into a running dev container.
- vpython-jupyter vendors `vpython/vpython_libraries/glow.min.js`, which reports
  `glowscript={version:"3.2"}` — the **same 3.2 line**, not a version boundary to
  cross.

So this is an alignment, not a port: **vpython-jupyter should consume trinket's
rsWVPRunner build**, vendored at release time under the same sha-pinning
discipline, and `gs_version.py` keeps working unchanged — it reads the version out
of whatever `glow.min.js` is present. One GlowScript build, two consumers, one
place to fix a rendering bug.

### A drift inside trinket, found while checking this

`public/js/embed/pyodide.js:23` hardcodes
`/components/vpython-glowscript/package/glow.3.2.2.min.js`. The Dockerfile
provisions **3.2.3** from rsWVPRunner alongside it; 3.2.2 is the older copy that
"stays in place as a fallback" from the components tarball. The Pyodide Web VPython
path is therefore running an older GlowScript than the `glowscript` embeds do, and
it does not pick up an rsWVPRunner redeploy at all.

Worth settling on its own merits, independent of any vpython-jupyter decision: if
3.2.3 is correct for the Pyodide path, this is a one-line change plus a smoke test;
if 3.2.2 is deliberate, the reason belongs in a comment next to the pin.

### The marriage: one transport interface, several hosts

vpython-jupyter today has exactly two front-ends, and neither reaches VS Code or
Colab:

| Front-end | Opens with | Where it works |
|---|---|---|
| `vpython_libraries/glowcomm.js` | `define([...])` (requirejs) then `IPython.notebook.kernel.comm_manager.register_target('glow', …)` | classic Notebook only — both globals are classic-only |
| `labextension/vpython` | a JupyterLab plugin (`src/index.ts`) | JupyterLab (the recent `jupyterlab4` merges) |

VS Code's notebook UI loads neither: it does not expose `IPython.notebook`, and it
does not load JupyterLab extensions. Colab has its own output-frame model. The
neutral shape that satisfies all of them — **and** the trinket worker — is the same
one: **a self-contained HTML+JS front-end that owns the GlowScript canvas and takes
messages over an injected send/receive pair**, with the host supplying the pipe:

| Host | The pipe |
|---|---|
| trinket worker (#108/#125) | `postMessage` on the existing worker channel |
| classic Notebook / JupyterLab | the existing Jupyter comm (today's two front-ends become thin adapters) |
| VS Code | the notebook renderer's messaging API |
| Colab | its output-frame channel |

The Python side already anticipates this: `baseObj.__init__` picks
`with_notebook` or `no_notebook` at runtime (`vpython.py:265-267`) behind a
module-global `sender`. Making that seam explicit — a named transport interface
with the existing two as implementations — is the change that buys all four hosts
at once. That is the concrete meaning of "marry them": **trinket contributes the
transport abstraction and the browser front-end, and supplies the GlowScript
build; vpython-jupyter keeps owning the object protocol.**

This also disposes of §14's "`glowcomm.js` has to be rewritten against our
channel" as if it were a cost unique to trinket. It is not — it is the piece
VS Code and Colab need too, so it is shared work rather than fork work.

### What this does not change

The sequencing in §14 stands, and if anything matters more now: **spike first**
(install `vpython` into Pyodide in the worker, import it, see where it stops), and
**not until #125 has landed and run on the trials**. A larger prize does not make
Web VPython less load-bearing for Matter & Interactions courses.

### Open questions for Steve

1. Does rsWVPRunner's `glow.3.2.min.js` satisfy vpython-jupyter's front-end, or
   has its vendored copy diverged? (The spike answers this incidentally.)
2. Is the `pyodide.js` 3.2.2 pin deliberate?
3. Does "married" mean vpython-jupyter stays a separately released PyPI package
   that trinket depends on, or does the browser half live in this repo? The
   transport abstraction is the same either way, so this can be decided later —
   but it decides where the front-end source lives.

---

## 16. Correction (2026-08-09) — the lineage, and why the vpython-jupyter protocol is the only one that fits an embed

Steve corrected §15's architecture read. The correction matters, and it turns out
to *strengthen* the proposal rather than weaken it.

### What §15 got wrong

§15 called trinket a "GlowScript publisher" because the `Dockerfile` fetches
sha256-pinned bundles from the `rswvprunner` GCS bucket. The distribution facts
are right; the authorship claim is not. **rsWVPRunner is a runner, not a build of
GlowScript.** The library is authored in the classic `glowscript` repo, and
`rsWVPRunner/package/` is a copy of `glowscript/package/` — identical bundle
lists, `glow.2.8` … `glow.3.2` — republished to GCS by `rsWVPRunner/do_build.sh`
(`gsutil -m cp -r deploy/* gs://rswvprunner`). Trinket *obtains* GlowScript
through that bucket; it does not author it.

**Consequent correction to the version story.** Upstream there is only
`glow.3.2.min.js`. The `.2` and `.3` suffixes are trinket's own filenames — the
`Dockerfile` renames the fetched `glow.3.2.min.js` to `glow.3.2.3.min.js`. So
`glow.3.2.2` vs `glow.3.2.3` are not two releases; they are **two build vintages
of the same 3.2 line**, the older from the components tarball. vpython-jupyter's
vendored `glow.min.js` also reports `version:"3.2"`. Everything in play is on the
3.2 line, which makes alignment a question of *build vintage and a single source
of truth*, not of version compatibility. §15's finding that `pyodide.js:23` pins
the older vintage still stands, and reads as a smaller problem than stated.

### The actual lineage — three implementations, one library

| | Implementation | Where Python runs | Where GlowScript runs | Coupling |
|---|---|---|---|---|
| 1 | classic `glowscript` GAE Flask app (oldest) | **nowhere** — RapydScript transpiles Python → JS | main thread | same realm; `rate()` is a cooperative yield |
| 2 | `vpython-jupyter` | **real CPython, in a Jupyter kernel** (separate process) | main thread | **comm channel** — buffered, browser-paced |
| 3a | `rsWVPRunner` (planned split, part 2) | nowhere — RapydScript, as #1 | iframe | as #1, relocated into an iframe |
| 3b | `wmWVPRunner` (planned split, part 3) | **CPython in Pyodide/wasm** | main thread | same realm — `from js import sphere, box, rate` |

The planned split of the Flask app is (1) a Flask app serving code from Datastore,
(2) rsWVPRunner, (3) wmWVPRunner — the last two being the same runner over
different execution engines.

**Trinket's Pyodide Web VPython is 3b.** That is where our bridge came from, and
3b's defining property — Python and GlowScript in the *same realm* — is exactly
what D2 encodes when it says moving VPython off-thread is "a replacement, not a
port".

So Steve's proposal, stated precisely: **replace wmWVPRunner's thin-façade
`vpython` package with vpython-jupyter's protocol package.** They are not variants
of one design; they are opposite strategies. wmWVPRunner's `vpython/` is a façade
(`core_funcs.py`, `vec_js.py`, `shapes_piodide.py`, `_async_transform.py`) over JS
objects in the same realm. vpython-jupyter's is the real object model
(`vpython.py`) with shadow state, feeding the browser a command stream.

### Why this is not merely an alternative — the SAB evidence

**Steve has already built the other worker port.** `wmWVPRunner` contains
"Option C (WebWorker)": a design spec and plan dated 2026-06-13, 5 phases, 16
tasks, 14 commits, documented in the webvpython `AGENTS.md`. Its architecture:

- `rate()` posts a message, then **`Atomics.wait`** — blocked until the main
  thread renders and notifies
- **every graphics call** does the same: `sphere(...)` posts `call_gfx` and blocks
  on `Atomics.wait` until an objectId comes back
- therefore **COOP/COEP headers** on both the Flask host and the Vite runner

Status: code complete, runtime integration broken — the iframe cannot reach the
dev server, with the COOP/COEP additions among the suspected causes.

That is the cost of moving a *synchronous façade* off-thread: you must simulate
synchrony, and `SharedArrayBuffer` is the only way to do it. And for trinket that
path is not expensive but **impossible** — SAB requires cross-origin isolation,
an iframe is only isolated if the **top-level page** is, and trinket embeds live
on LMS pages and teachers' blogs we will never control. That is Global Constraint
1, and Option C is the concrete demonstration of it.

**vpython-jupyter needs none of it**, because it never had synchrony to preserve:

- updates are buffered in `baseObj.updates` = `{cmds, methods, attrs}`
  (`vpython.py:204`)
- the **browser drives the flush** — `glowcomm.js` sends a canvas-update event
  about every 33 ms; `trigger()` packages the buffer and calls `sender(objdata)`
  (`vpython.py:321-337`, and the design note at `:356-373`)
- attribute reads are served from Python-side shadow state — no round trip
- backpressure is `while not baseObj.sent: time.sleep(0.001)` (`:291`) — a *yield
  point*, harmless in a worker, and already what our cancellation hooks key on

A Web Worker is just one more "separate execution context reached by an
asynchronous channel" — the situation vpython-jupyter was built for. The port is
substituting `sender`.

**This is the strongest argument available for the proposal:** of the two worker
designs, only the vpython-jupyter one can run in a trinket embed at all.

### cyvector is a performance question with a known answer

vpython-jupyter's `_vector_import_helper.py` falls back to pure-Python `vector.py`
when the Cython `cyvector` is unavailable, so nothing blocks. But vector math is
the hot path, and `trigger()` converts vectors on every flush — so the fallback
is a real cost, not a free one.

Steve has built the wasm wheel before, and webvpython's `AGENTS.md` carries the
exact recipe. It is currently disabled in `wmWVPRunner/vpython/vec_js.py` only
because the existing wheel is `cp311` / Emscripten 3.1.39 while Pyodide 0.29.4
needs `cp313` / 3.1.58; the source with its kwargs fix lives in Steve's Pyodide
fork (`packages/cyvector/cyvector/cyvector.pyx`, `sjs` branch). A rebuilt wheel
would drop straight into vpython-jupyter through that same import helper — **one
wheel serving both**.

### How this changes the recommendation

D2 should be reversed, for a sharper reason than §14 gave. It was priced as "the
bridge is expensive to replace". The real finding is that **the bridge cannot be
moved off-thread in an embed at any price**, and the replacement is a package that
already runs the way an embed requires.

The spike in §14/§15 is unchanged but its question sharpens: install `vpython`
into Pyodide in the worker, swap `sender` for a `postMessage` function, and see
whether the buffered `trigger()` loop drives a scene. Sequencing is still after
#125 has landed and run on the trials.
