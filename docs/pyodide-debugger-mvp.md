# Pyodide Step Debugger — scoping / MVP

Status: **scoping — not yet implemented.** Follow-up to the variable explorer
(#17, #26 / PR #42), which explicitly deferred "live/stepping debugger view"
as out of scope.

A **record & replay** debugger for Pyodide ("Python") trinkets: run the
program once with a `sys.settrace` recorder, then let the student step
**forward and backward** through the recording — current line highlighted in
the editor, a per-step view of variables, and console output revealed in sync
with the steps. Python-Tutor-style, scoped to the Pyodide runner only.

## Why record & replay (and not live stepping)

Pyodide runs **on the browser's main thread** in this codebase. A classic
pause-at-breakpoint debugger must block Python mid-execution while the UI
stays interactive — impossible on one thread: blocking Python freezes the
page, including the debugger controls.

True live stepping would require:

- Pyodide in a **Web Worker**, blocked at breakpoints via
  `SharedArrayBuffer` + `Atomics.wait`;
- `COOP`/`COEP` cross-origin-isolation headers (a Caddy/server change that
  affects how trinkets can be embedded on third-party sites);
- proxying every DOM touchpoint out of the worker — matplotlib's canvas
  target, the VPython/GlowScript bridge, jqconsole I/O all assume main-thread
  DOM access today.

That is weeks of destabilizing surgery on a working runner. Record & replay
needs **none** of it — the program runs exactly as it does now, plus a tracer;
all "debugging" happens afterwards against recorded data. For the student
audience, replay is arguably better than live stepping anyway: **stepping
backwards** (impossible in a live debugger) is the single best tool for
understanding loops, and the recording is deterministic — no "oops, stepped
past it, re-run".

Trade-offs accepted:

- The program **runs to completion first** (with output suppressed/buffered),
  so this is not for infinite loops or long animations. A step cap converts
  runaway programs into a friendly "recording stopped after N steps" note.
- `input()` prompts happen during the recording run, in order, like a normal
  run; the replay then shows each prompt/response at the step it occurred.
- VPython/GlowScript runs are **excluded** (they're rewritten/async and render
  continuously; stepping a 60fps animation loop is meaningless). The Debug
  button hides for programs that `usesVPython()`.
- **Step-through runs in a fresh namespace; normal Run does not.** Run execs
  in the persistent `pyodide.globals`, so state accumulates across Run clicks
  (define `x` in one Run, delete the line, the next Run still sees `x`).
  Step-through always executes the program as a standalone script in a fresh
  dict — the same code can therefore `NameError` under Step-through while Run
  "works". The fresh namespace is the more honest semantics for teaching (it
  shows what the program does on its own); the button tooltip says so
  ("Records your program running from scratch…").

## Integration points (verified in code)

| Concern | Hook | Location |
|---|---|---|
| Program execution | `pyodide.runPythonAsync(prog)` after `loadPackagesFromImports` | `pyodide.js` `startRun()` |
| Stdout/stderr capture | `py.setStdout({batched})` / `py.setStderr({batched})` → `writeOut` | `pyodide.js` ~L117 |
| Line highlighting | `api.highlightLine(file, line)` → `editor.highlight(file, line)` | `pyodide.js` ~L1093 |
| Variables rendering | Phase 1–3 explorer table (`renderVariables`, `varRowHtml`, guards) | `pyodide.js` |
| Where controls go | `#outputTabs` / toolbar, same pattern as `#variablesTab` | `embed/pyodide.html` |
| Feature gating | `features.variableExplorer` precedent → new `features.stepDebugger` | `config/default.yaml`, template `{% if %}` |

## Recorder design (Python side)

A `RECORD_HELPER` in the established style (string of Python run in a
throwaway namespace, `json.dumps` result back to JS — zero pollution of user
globals):

- Install `sys.settrace(tracer)` and re-exec the user program **inside the
  tracer's control** (a second, instrumented run — see "two-run model" below).
- On each `line` event in **user code only** (filter: `frame.f_code.co_filename`
  is `<exec>` or under the Pyodide FS workdir — skips all
  library/site-packages frames):
  - record `{step, file, line, func, depth}`;
  - snapshot the frame's `f_locals` (module frame → globals) using the
    explorer's existing filtering + repr-truncation rules (skip dunders,
    modules, injected names; repr ≤ 120 chars here — tighter than the
    explorer's 300 because it's per-step);
  - record the current **stdout length** so replay can reveal output
    incrementally.
- On `call`/`return` events: push/pop a frame-name stack so replay can show
  "inside `f(x)` called from line 12".

### Caps (all produce a visible "recording truncated" note, never an error)

| Guard | Value (initial) | Why |
|---|---|---|
| Max steps recorded | 5 000 | a `for i in range(10**9)` must not hang the tab |
| Max vars per step | 50 | keep snapshots small |
| Max repr length | 120 chars | per-step payload size |
| Max total recording size | ~2 MB JSON | absolute backstop |
| Max frame depth traced | 20 | deep recursion |

### Snapshot cost honesty

`settrace` + per-line repr is **slow** — expect 10–100× slowdown on the
recording run. Acceptable because (a) debug is opt-in per click, (b) the step
cap bounds total work, (c) target programs are teaching-scale (tens–hundreds
of lines). The doc for students should say "Debug re-runs your program slowly
to record it."

### Two-run model

Clicking **Debug** performs a **fresh instrumented run** (it does not reuse
the last normal run): same FS sync, same package loading, then
`RECORD_HELPER` wraps the exec. Normal **Run** is untouched — zero overhead
when not debugging. Matplotlib in a debug run: allowed, figures appear at the
end as usual; plot state is not stepped.

## Replay UI

- **Debug button** next to Run (gated on `features.stepDebugger`, hidden for
  VPython programs). Click → instrumented run → on completion, enter replay
  mode.
- **Step controls bar:** `⏮ first · ◀ back · step k / N (slider) · ▶ forward · ⏭ last · ✕ exit`.
  Keyboard: ←/→ step, Home/End jump.
- **Current line highlight** in the editor via the existing
  `editor.highlight` path (editor shown side-by-side with output, as in edit
  view).
- **Variables panel reuse:** the recorded snapshot for step *k* is rendered
  through the existing explorer table (name/type/repr) with a
  "`inside f() — called from line 12`" header when depth > 0. Phase 3
  expansion is **disabled in replay** (recorded snapshots are flat by design;
  live expansion would show *final* state, which lies about step *k*).
- **Console sync:** replay shows stdout only up to the recorded offset for
  step *k* — output "appears" as you step past the `print` that produced it.
- Exiting replay (✕, editing code, or clicking Run) restores the normal
  Result view and live explorer.

## Files touched

| File | Change |
|---|---|
| `public/js/embed/pyodide.js` | `RECORD_HELPER`, `runDebug()`, replay state + step controls logic, console-sync, highlight driving |
| `lib/views/embed/pyodide.html` | Debug button, step-controls bar markup, scoped CSS |
| `config/default.yaml` | `features.stepDebugger: false` |
| `docs/pyodide-debugger-mvp.md` | this doc |

No server routes/models; no shared embed-framework changes; no new
dependencies. Same blast-radius discipline as the explorer.

## Phasing

- **Phase 1 — recorder + minimal replay (~2–3 d):** Debug button; instrumented
  run with all caps; forward/back stepping with line highlight; per-step
  variables via the existing table (module-level frame only); truncation
  notes.
- **Phase 2 — frames & console sync (~1–2 d):** function-call frames (show the
  executing frame's locals + "called from" breadcrumb), stdout revealed in
  step-sync, slider + keyboard navigation.
  **Implemented** (stdout sync + keyboard nav landed early, in Phase 1):
  - step **slider** for scrubbing (live line/vars/console while dragging);
  - **"called from line N"** breadcrumb — the recorder captures the nearest
    user call-site frame (`from_line`/`from_file`), shown as
    `inside f() — called from [helper.py ]line N`;
  - **multi-file stepping** — the tracer follows user modules imported from
    the Pyodide FS (`_user_prefix`), labels steps with the file, and replay
    switches editor tabs via `editor.selectFile` (only for files actually
    open) before highlighting;
  - **changed-variable highlighting** (pulled forward from Phase 3): rows
    whose value is new or different from the previous step get `.var-changed`.
- **Phase 3 — breakpoints (implemented):**

  - **Gutter breakpoints** (supersedes the earlier "run to line" idea —
    instructor-suggested refinement). Clicking left of a line number toggles a
    breakpoint marker there; replay gains **next/previous-breakpoint**
    navigation that jumps `debugIdx` to the nearest recorded step matching a
    breakpoint's (file, line). In the record & replay model a breakpoint
    pauses nothing — it is a navigation filter over the finished recording —
    so breakpoints are **fully dynamic**: students can add/remove them
    mid-replay and jump targets update instantly. Ace does the UI natively
    (`guttermousedown` for the click, `session.setBreakpoint`/
    `clearBreakpoint` for the classic gutter dot), and the Phase 2 per-file
    sessions give per-file breakpoints in multi-file trinkets for free.
    Estimated ~0.5 d.
  - **Deferred recording ("start at first breakpoint")** — the companion
    feature that makes breakpoints matter for long programs. Navigation-only
    breakpoints can't reach code the recording never reached: a big early
    loop can burn the whole 5 000-step cap before the interesting part. With
    breakpoints set, the tracer stays dormant (no snapshots, minimal
    overhead) until execution first touches a breakpoint line, then records
    normally — letting students skip past long preambles rather than merely
    navigating within what got recorded. Implementation notes: dormant line
    events are still counted and capped (`_max_dormant`, 200 000) so an
    infinite loop *before* any breakpoint can't spin forever; the result
    carries `armed`/`skipped` so the UI can say "recording started at the
    first breakpoint" or "no breakpoint was reached — nothing recorded".
  - **Loop-iteration jump** ("next time line 8 runs") — largely subsumed by
    next-breakpoint navigation on a breakpointed line; keep only if a
    dedicated control proves necessary.
  - ~~Diff-highlighting of changed variables between steps~~ — **done**
    (pulled forward into Phase 2 as `.var-changed`).

## Out of scope (explicitly)

- Live pause/breakpoint debugging (worker + SAB architecture) — revisit only
  if record & replay proves insufficient in classrooms.
- VPython/GlowScript debugging.
- Watch expressions / conditional breakpoints.
- Stepping *into* library code.

## Product decisions (resolved 2026-07-07)

1. **Button label: "Step through"** (may revisit later).
2. **Replay lives in the Variables tab** — a step-controls bar in the panel
   toolbar; the launch button also lives there, so the flow is: open
   Variables → "Step through" → step. `features.stepDebugger` therefore
   **requires `features.variableExplorer`** (the markup nests inside it).
3. **Step cap 5 000** confirmed as the starting value.
4. **Cancel:** included, with honest semantics. On the main thread, JS cannot
   interrupt the synchronous traced `exec` — no click can even be processed
   while it runs. So: (a) the **cap aborts from inside the tracer** (raising
   a private exception at `MAX_STEPS`/size cap), which is what actually
   bounds runaway programs — even `while True:` ends at the cap; (b) the
   Cancel button works during the pre-exec async phases (Pyodide load,
   package fetch), which is where real waiting happens.

### Corrections found during implementation

- `input()`/stdin is **not supported by the Pyodide runner at all** (declared
  out of scope in `pyodide.js`'s header), so replay needs no input handling —
  simpler than this doc originally assumed.
- `editor.highlight()` applies **error** styling (red marker + error icon on
  the file tab), so the debugger drives Ace directly with its own
  `debug-current-line` marker class instead of reusing that hook.
- The recorder traces frames whose `co_filename` is the compiled main file
  (`<debug>`); functions defined in the main file trace naturally. Stepping
  into imported user modules is deferred to Phase 2.
- A synthetic final **"end" step** is appended (full output, final globals),
  so stepping past the last line shows the program's terminal state.
