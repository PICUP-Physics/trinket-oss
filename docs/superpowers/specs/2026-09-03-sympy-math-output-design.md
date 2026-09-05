# Typeset SymPy output in Pyodide trinkets — design handoff

Status: slice 1 — main thread only, behind `features.mathOutput`, default off — is implemented in
**#240**. This document lands ahead of that PR by design, so check whether #240 has merged before
assuming the code is present on `main`. Worker parity waits on #215. Q3, Q4 and Q6 are still
Andrew's calls; Q8 was revised after measurement (see the log at the bottom).

![Typeset SymPy output in a Pyodide trinket](../images/2026-09-04-sympy-math-output.png)

Slice 1 as built. Line 4 assigns and stays silent; the bare `eq` on line 5 typesets; `print` lands
between the cards in program order; the bare `42` and the bare string on lines 8 and 9 produce
nothing, which is what makes this a no-op for existing trinkets; a list of SymPy objects typesets;
and each card carries the student's own source line, numbered as in the code window.


Prepared for Andrew (maintainer of the PICUP trinket server) and for the Claude Code
assistant working in this repository (`PICUP-Physics/trinket-oss`). Written 2026-09-03
after a read-only review of the codebase, when nothing had been implemented; slice 1 has
been built since, as the status above says. The Part A questions below stand as originally
posed — the answers, including the ones that changed once there was code to measure, are
in the running log at the end.


## Reference commit and line anchors

Every `file:line` below refers to **PICUP-Physics/trinket-oss, branch `main`, commit `b3c156f`**
(fetched 2026-09-03). Re-checked the same day against `main` at `0f9a07e` (after PRs #222 and #214),
and again on 2026-09-04 against `66d7edc` — the commit the implementation plan pins to, and the base
slice 1 was built on. None of the cited files changed at any of the three, so every line below is
exact there too. The Clear memory feature this document leans on (formerly
`feature/clear-python-memory`) is already merged there. Line numbers drift as `main` moves; the
anchors below are stable strings to grep for when they do.

| Anchor (grep for this) | File | Line at b3c156f |
|---|---|---|
| `// Console output buffering (#142)` | public/js/embed/pyodide.js | 145 |
| `function consoleWrite(` | pyodide.js | 228 |
| `function escapeConsoleHtml(` (comment above it starts at 320) | pyodide.js | 334 |
| REPL echo `pyodide.runPython('repr')(value)` | pyodide.js | 480 |
| `__trinket_reset_baseline__ = dict(globals())` (bootstrap snapshot) | pyodide.js | 657 |
| `function showGraphic(` | pyodide.js | 736 |
| traceback filter `out.push('  File "' + name` | pyodide.js | 900 |
| `function usesConsole(` / `function userShadowsConsole(` | pyodide.js | 941 / 952 |
| `function ensureGlow(` | pyodide.js | 961 |
| `function ensureConsoleTransform(` | pyodide.js | 1027 |
| `function runVpython(` | pyodide.js | 1050 |
| `function renderRichResult(` / `function showRichHtml(` | pyodide.js | 1136 / 1155 |
| step-debugger copy of `usesConsole(prog) && !userShadowsConsole()` | pyodide.js | 1893 |
| Variables copy: `navigator.clipboard.writeText` … `execCommand('copy')` | pyodide.js | 1973–1984 |
| `function clearMainThreadMemory(` | pyodide.js | 2594 |
| `function handleWorkerFigure(` | pyodide.js | 2625 |
| `function runInWorker(` | pyodide.js | 2680 |
| `function finishRun(` | pyodide.js | 2790 |
| `function startRun(` | pyodide.js | 2864 |
| matplotlib target `pyodideMplTarget = document.getElementById('graphic')` in startRun | pyodide.js | 2963 |
| run-path `usesConsole(prog) && !userShadowsConsole()` | pyodide.js | 2982 |
| `renderRichResult(result);` | pyodide.js | 2997 |
| run-path traceback `consoleWrite(` … `'jqconsole-error'` | pyodide.js | 3010 |
| `captureAndSaveSnapshot` | pyodide.js | 3615 |
| `pyodide.setStdout({ batched:` | public/js/embed/pyodide-worker.js | 103 |
| `self.__trinket_worker_figure = function` | pyodide-worker.js | 217 |
| worker REPL echo `post({ type: 'stdout', text: pyodide.runPython('repr')` | pyodide-worker.js | 496 |
| worker run `return pyodide.runPythonAsync(src)` | pyodide-worker.js | 573 |
| `if (msg.type === 'figure')` | public/js/embed/worker-client.js | 70 |
| outputOnly layout `{% if outputOnly %}` … `#console-output aria-live="polite"` | lib/views/embed/pyodide.html | 400–407 |
| `<div id="graphic" … role="application"` | pyodide.html | 422 |
| `<div id="console-output" aria-live="assertive"` | pyodide.html | 428 |
| `features:` / `workerRuntime:` / `pyodideVersion:` | config/default.yaml | 10 / 16 / 54 |
| MathJax 2.7.7 in course editor / class page lists | config/default.yaml | 322 / 359 |
| `calculatorOption:` | config/default.yaml | 479 |
| `csp:` / `cdnOrigins:` / `standard: >-` / `exam: >-` | config/default.yaml | 568 / 573 / 582 / 591 |
| `.jqconsole { … white-space: pre-wrap` / `.jqconsole-output { color: white` | static/scss/embed/_python.scss | 255 / 317 |
| `$('#instructionsOutput').html(` | public/js/embed/embed.js | 2244 |
| `// MathJax typesets the page AFTER markdown renders` | public/js/trinket-markdown-modern.js | 244 |
| `## 4. Protocol` (message names fixed by spec, rule 6 at line 22) | docs/superpowers/specs/2026-08-08-pyodide-worker-runtime-design.md | 116 |

---

## Part A — Questions for Andrew

These decide scope and ordering. Answers change the plan in the ways noted.

1. **Is `features.workerRuntime` turned on in the production config overlay?**
   The worker design spec calls the worker "the common case" and `config/default.yaml:16`
   documents it as the intended default. If production runs the worker, the worker path
   must be in the first slice or the feature is invisible there.

2. **Are `runMode=calculator` (exam) embeds ever used with Python/Pyodide trinkets, and is
   `app.csp.enabled` on in production?** Today only glowscript implements the calculator
   layout (`config/default.yaml:475-480`). If exams use Python trinkets, the math renderer
   must be vendored from day one (no CDN), and giving the Python embed a calculator layout
   is extra scope.

3. **Is vendoring KaTeX the way the other components are vendored acceptable?** That means a
   pinned version and sha256 in the Dockerfile plus `npm run setup-vendor`, into
   `public/components/katex/`, following `COMPONENTS.md`. Roughly 1–1.5 MB on disk
   (JS, CSS, ~20 woff2 fonts); a page loads ~400 KB of it lazily on first use.

4. **Math in trinket Instructions is not typeset inside the embed. Do you want that fixed
   with the same renderer?** The markdown renderer passes `$...$` through untouched
   expecting MathJax to typeset afterward (`public/js/trinket-markdown-modern.js:244`).
   MathJax loads on course/class pages (`config/default.yaml:322,359`) but never in the
   embed, and the embed injects the parsed instructions as-is (`public/js/embed/embed.js:2244`).
   So `$E=\frac{1}{2}mv^2$` is typeset on a course page and shows as raw TeX inside the
   trinket iframe. Once KaTeX is vendored, auto-rendering `#instructionsOutput` is small.
   Separate feature; needs a yes/no.

5. **Which Pyodide version is deployed, and is a bump acceptable?** `features.pyodideVersion`
   pins it (0.28.1 in default.yaml). It fixes the SymPy version students get.

6. **Should the new behaviors be deployment config or per-trinket settings?** Specifically:
   the feature flag itself, the "echo source line above each result" behavior, and the
   default copy format. The repo already has a per-trinket runtime setting
   (`docs/superpowers/specs/2026-08-12-trinket-runtime-setting-design.md`) to model on.

7. **How are trinkets embedded on your course pages and in the LMS?** If the trinket iframe is
   cross-origin to the host page, the async clipboard API needs
   `allow="clipboard-write"` on the iframe. The current embed snippet
   (`lib/views/includes/shareModals.html`) does not set it. This affects the copy buttons
   (text and image) in the polish slice; a download fallback works regardless.

8. **Is the 5,000-line console cap (`console-buffer.js`) still the right budget once each
   math block counts against it?** A derivation loop displaying thousands of expressions
   must be capped like text; proposal is to count each math block as one line.

---

## Part B — Background and proposed plan (for Claude Code)

### The goal

A physics student uses SymPy in a Python trinket. Today a bare expression prints nothing
when Run, and `print(expr)` shows a plain-text repr. The desired experience is what a
Jupyter notebook gives: the expression rendered as typeset mathematics, in order with the
program's other output, so a multi-step derivation reads like a worked example.

Decisions already made by Larry (the requester):

- **Every module-level bare expression statement displays**, not only the last one. A
  trinket is a whole program, not a single notebook cell.
- **Only objects that can typeset themselves display.** Anything with `_repr_latex_`
  (all SymPy `Printable` objects), plus plain lists/tuples/dicts of such objects. Ints,
  strings, matplotlib return values and every other bare value stay silent, exactly as a
  script does today. This is zero behavior change for existing trinkets.
- **Echo the source line above each result**, prefixed with its line number in the
  trinket's code window, with the typeset result indented beneath it. Echo only when
  something is actually displayed, so `print(...)` and `plt.plot(...)` (also bare
  expression statements) are never echoed.
- **Render inline in the console**, interleaved with `print` output in program order, not
  in the `#graphic` pane.
- **KaTeX, vendored**, as the renderer.
- A later slice adds **copy as LaTeX / Python text / unicode pretty-print / PNG image**,
  switchable per math block.

### What exists today (verified by reading; line numbers refer to PICUP-Physics/trinket-oss `main` at b3c156f; see the reference table above)

Runtime: `/embed/pyodide`, real CPython via Pyodide from jsDelivr. Two execution modes:
main thread, and a Web Worker behind `features.workerRuntime`.

- `public/js/embed/pyodide.js` (main-thread runner, ~3,580 lines)
  - Console output buffering (#142) at :145-231. `writeStream`/`writeOut` queue into a
    rAF-coalesced buffer with a 5,000-line cap; `consoleWrite()` flushes first so styled
    writes never jump ahead of program output. The accounting is pure and node-tested in
    `public/js/embed/console-buffer.js`.
  - `escapeConsoleHtml()` at :334, with the comment at :320 explaining why console text
    is student-controlled and must be escaped (real XSS and eaten-markup hazard).
  - Bootstrap namespace snapshot at :652-662: `__trinket_baseline__` (names the Variables
    panel hides) and `__trinket_reset_baseline__` (what **Clear memory** restores at
    :2594-2600). Anything installed *before* this snapshot survives a clear.
  - `ensureConsoleTransform()` at :1027: fetches `_async_transform.py`, writes it to the
    Pyodide FS, imports `transform_source`. The console-module run path at :2982-2989
    re-imports it after every Clear memory on purpose.
  - `renderRichResult()` at :1136: checks the last top-level expression's value for
    `_repr_html_` and renders into `#graphic` via `showRichHtml()` at :1155 (box styled
    `height:100%`, so it cannot stack). Does not check `_repr_latex_`.
  - `startRun()` at :2864: the main run pipeline. matplotlib target setup at :2963,
    `renderRichResult(result)` at :2997, traceback filter at :3010.
  - **Four run pipelines exist**, not two: `startRun` (:2864), `runInWorker` (:2680),
    `runVpython` (:1050), and the step-debugger recording, which has its own copy of the
    console-transform branch near :1893.
  - REPL result echo is a plain `repr` at :480 (main) and `pyodide-worker.js:496` (worker).
  - Run console palette is white-on-dark (`static/scss/embed/_python.scss:317`); the REPL
    palette behind `.console-mode` is light. The console ancestor is `white-space: pre-wrap`
    (`_python.scss:255`).
  - Variables panel copy button uses `navigator.clipboard.writeText` with an
    `execCommand('copy')` fallback at :1973-1984.
- `public/js/embed/pyodide-worker.js`: the worker kernel; never touches `document`.
  stdout is posted per batched line (:103). Figures cross as a `figure` message (:217).
  The run executes at :573 via `pyodide.runPythonAsync(src)`.
- `public/js/embed/worker-client.js` :32-120: typed message dispatch; `figure` is scoped to
  the current run id at :70-73. Unknown message types are silently ignored.
- `public/js/embed/wvpython/vpython/_async_transform.py`: the existing source transform.
  Pure `ast`, decides via AST but applies **textual** `async `/`await ` insertions that
  never add or remove lines (:23-28), so line numbers survive. Returns a string.
- `lib/views/embed/pyodide.html`: DOM. Both layouts have `#graphic-wrap` / `#graphic`,
  `#output-dragbar`, `#console-wrap` / `#console-output`. Editor layout: `#console-output`
  is `aria-live="assertive"` (:428); `#graphic` is `role="application"` (:422), which tells
  screen readers not to read its content. outputOnly layout (:400-407) has no
  `#outputContainer`.
- `config/default.yaml`: `features:` at :10-20. CSP at :568-596; `cdnOrigins` allows
  cdnjs and jsdelivr in both the standard and exam policies, with the stated direction that
  vendoring should let that list empty out.
- `public/js/util/html-to-image.js` (foreignObject rasterizer) is loaded in the editor
  layout for snapshots (`captureAndSaveSnapshot` at `pyodide.js:3617`). It inlines
  `@font-face` fonts only from stylesheets whose `cssRules` are readable, i.e. same-origin.
  Exposes `toPng`, `toBlob`, `pixelRatio`, `backgroundColor`, `fontEmbedCSS`.
- `COMPONENTS.md`: vendoring pattern (gitignored `public/components/`, fetched by
  `npm run setup-vendor` and the Dockerfile, pinned version + sha256).
- Design docs live in `docs/superpowers/specs/` and `docs/superpowers/plans/`; the worker
  protocol table is in `2026-08-08-pyodide-worker-runtime-design.md` (§4), and it states
  message type names are fixed by the spec.

SymPy facts: no `init_printing()` is needed. `sympy.core._print_helpers.Printable`
defines `_repr_latex_()` returning e.g. `$\displaystyle \int \sqrt{\frac{1}{x}}\, dx$`.
Plain containers of expressions have no `_repr_latex_`; use `sympy.latex(container)`.
Outside IPython, `sympy.init_printing()` **replaces `sys.displayhook`**, which students
copy from notebook material constantly.

### Architecture

**Feature flag.** `features.mathOutput: false` in `config/default.yaml`, surfaced to the
client alongside the other flags (see how `variableExplorer` reaches
`window.trinket.config`). A sub-option for the source-line echo (default on).

**One Python module, four pipelines.** Add a small pure-Python module (suggested name
`_trinket_display.py`, served from `public/js/embed/` like `_async_transform.py`, written
to the Pyodide FS at bootstrap in **both** runtimes, before the baseline snapshot so Clear
memory keeps it). It provides:

1. `display(*objs)` installed on `builtins`. The explicit escape hatch for loops and
   functions, and a real notebook idiom.
2. A classifier: returns a payload for objects with `_repr_latex_` (handle it returning
   `None`, a string, or an IPython-style `(data, metadata)` tuple), and for
   list/tuple/dict whose leaves are SymPy objects via `sympy.latex()` — only when `sympy`
   is already in `sys.modules`; never import it yourself. Everything else returns nothing.
3. The **top-level expression hook**. Parse the (already async-transformed) source with
   `ast`, and for each module-level `ast.Expr` node wrap its value in a call to a hidden
   hook: `Expr(Call(hook, [value, lineno]))`, with `ast.copy_location` /
   `fix_missing_locations` so tracebacks keep their lines. Do **not** wrap expressions
   inside `if`/`for`/`def` bodies; that matches Jupyter, where a bare expression inside a
   loop shows nothing and students use `display()`. **The hook returns its argument**, so
   Pyodide's last-expression return still yields the value and `renderRichResult` keeps
   firing for pandas; existing trinkets see no change.
4. A pluggable **sink**: on the main thread a JS callback (`from js import ...`), in the
   worker a posted `rich` message. Payload: `{ latex, text, lineno, source }` where `text`
   is a single-line `str(obj)` fallback and `source` is the echoed line(s) from the main
   file (`ast.get_source_segment`). For `display()` called from a function or a secondary
   module, read the caller frame's filename and line number; echo as `file.py:12` when the
   file is not the main file.

**Compile through Pyodide's own seam.** Use `pyodide.code.CodeRunner` (construct, mutate
`.ast`, `.compile()`, `await .run_async(globals)`) rather than a second text rewrite. It
keeps the `<exec>` filename the traceback filter at `pyodide.js:900` depends on, and it
composes with `transform_source` trivially: that is a text pass that preserves line
numbers; parse its output. **Verify the CodeRunner API surface against the deployed
Pyodide version's docs before relying on it.**

Why not `sys.displayhook`: `sympy.init_printing()` replaces it outside IPython, so a
displayhook design silently loses to the very library the feature exists for. The AST wrap
is immune, and still honors the student's intent (typeset math) when they call it.

Why not a text-level second transform: two textual rewrites of the same source compose
badly (column offsets, `await` insertions inside wrapped calls). The AST wrap is
IPython's own approach (`run_ast_nodes` with `ast_node_interactivity='all'`).

**Console rendering (JS).**

- Extend `console-buffer.js` so the queue holds **rich segments** alongside text. One flush
  appends text spans and math nodes in program order, and each math block counts against
  the line cap (proposal: one line each; drop when capped, like text). Keep the module pure
  and add node tests for ordering and capping.
- Markup per result: a block-level "output card" with a light background so it reads like a
  notebook cell on both the dark Run palette and the light REPL palette. Structure:
  echo line (`12  sol = dsolve(eq)`, muted monospace, line number first) then the typeset
  math indented beneath. Set `white-space: normal` on the card to escape the console's
  `pre-wrap`.
- Lazy-load vendored KaTeX (JS + CSS) on first typeset, memoized like `ensureGlow()` at
  `pyodide.js:961`. Strip the `$...$` delimiters SymPy adds; render with
  `displayMode: false` (SymPy already emits `\displaystyle`), left-aligned as a block.
- KaTeX options: `trust: false`, `throwOnError: false`, `maxExpand: 1000` (a
  student-defined `_repr_latex_` can otherwise loop the macro expander). Never concatenate
  Python text into that HTML; the echo line and the `text` fallback go through
  `escapeConsoleHtml()`.
- Accessibility: keep KaTeX's default `htmlAndMathml` output. The MathML is what screen
  readers speak. Do **not** put `sympy.pretty()` box-drawing art in an `aria-label`.
- If KaTeX fails to load (offline, blocked), fall back to writing the `text` payload as a
  normal console line so the run still shows something.

**Worker parity.**

- Add a `rich` worker→page message `{ id, latex, text, lineno, source }` to the protocol
  table in the 2026-08-08 spec, and dispatch it in `worker-client.js` scoped to the current
  run exactly as `figure` is (:70-73). Adding a type does not break an old page (unknown
  types are ignored).
- Replace the bare `runPythonAsync(src)` at `pyodide-worker.js:573` with the module's
  runner when the flag is on. The Python module is identical in both runtimes; only the
  sink differs.

**Known edge cases to handle or document.**

- Ordering: Pyodide's batched stdout flushes on newline only, so `print("x =", end="")`
  followed by a typeset expression renders out of order in both runtimes. Either flush
  `sys.stdout` inside the hook before posting, or document it.
- Module docstrings and bare strings are `Expr` nodes; the classifier ignores them.
- Secondary `.py` files are imported, not run through the wrapper; bare expressions there
  display nothing (correct; matches Python), `display()` works.
- Clear memory: install into `builtins`/`sys.modules` before the baseline snapshot
  (`pyodide.js:652`) so the restore at :2594 keeps it. The worker boots fresh after a
  clear, so bootstrap install covers it.
- jqconsole: the vendored component was not available for inspection. Confirm whether
  `Append(html)` inserts before or after an armed REPL prompt; `Write` is known-good here.
- Snapshot capture targets `#outputContainer`, which does not exist in the outputOnly
  layout. Pre-existing; means snapshot fidelity only matters in the editor layout, and
  vendored (same-origin) KaTeX CSS is what lets html-to-image embed the math fonts there.

### Copy formats (polish slice)

Reuse the Variables-panel pattern: a hover/focus button on each math card opening a small
menu with four targets.

- **LaTeX** — the `latex` payload without delimiters.
- **Python** — the `text` payload (`str(expr)`), pastes back into code. Proposed default
  for plain select-and-copy of the console; remember the last-chosen format in
  `localStorage`.
- **Pretty** — `sympy.pretty(expr)` unicode; computed on demand in Python, not shipped
  with every result.
- **Image** — rasterize the math node with the already-loaded html-to-image:
  `toBlob(node, { pixelRatio: 2 or 3, backgroundColor: '#fff' })`, then
  `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`. PNG is the
  right format: it is what the clipboard API accepts everywhere and what pastes into Word,
  Google Docs and slides. Always render on a white background so the image is usable in a
  document regardless of console palette. Because the KaTeX CSS is same-origin, the fonts
  embed correctly. Provide a **Save image** download fallback for browsers without
  `ClipboardItem` PNG support and for cross-origin iframes lacking `clipboard-write`
  (see question 7).

### Slices

**Slice 1 — the useful one.** Flag; vendored KaTeX with lazy load; the Python module
(display builtin, classifier, AST hook, sinks) installed at bootstrap in both runtimes;
console-inline rendering through the extended buffer with the light card, line-numbered
source echo and `str()` fallback; wired into `startRun` **and** the worker run (one production deploy runs the worker; see Q1 below); `rich`
message in the protocol spec; a loading notice in the console, in the style of the existing
`Loading packages…` line, because a student's first typeset expression waits on the SymPy import
(~3.3 s on 0.28.1) plus the lazy KaTeX load (~400 KB); vendored KaTeX referenced under the
`/cache-prefix-<commit>/` path so it is served `immutable` (the pattern PR #233 applies to the glowscript
runner), not at a bare `/components/` path; node tests for the buffer and pure-Python tests for the AST
wrap (testable outside Pyodide, like `_async_transform.py`), run under **Python 3.13 and 3.14** since Pyodide is
about to move to 3.14 (#215). Never hard-code the SymPy version; detect `_repr_latex_` at run time.
Acceptance: a program mixing several bare SymPy expressions and `print` calls shows
line-numbered echoes with typeset results interleaved in order, on whichever runtime the
deploy uses; an existing trinket with the flag on behaves identically to before.

**Slice 2.** REPL echo (`pyodide.js:480`, `pyodide-worker.js:496`): if the value has
`_repr_latex_`, render the card instead of `repr`. Step-debugger recording pipeline and
`runVpython` pipeline use the same runner.

**Slice 3.** Route `_repr_html_` (pandas) through the same hook into the console card,
retiring the `#graphic` HTML path. Optionally typeset Instructions with KaTeX auto-render
(question 4).

**Slice 4.** Copy menu including PNG; cap tuning; per-trinket settings if wanted.

### Unverified claims — status

Probed 2026-09-03 by a collaborator running Python inside the deployed 0.28.1 embed.

1. **Verified.** `pyodide.code.CodeRunner` exists, its `.ast` is a `Module` and assignable, compiling after
   mutation works, and `run_async` is present. The AST-wrap architecture is viable as written.
2. **Answered (2026-09-04, from jqconsole's source).** `Write(text, cls, escape)` builds a span and
   delegates to `Append(node)`, which does `insertBefore(this.$prompt)` and then re-attaches the cursor
   after the prompt. So output always lands **above** an armed prompt and the prompt stays live below it —
   confirmed in the running REPL as well as in `lib/jqconsole.js`. `Write` is the right call; no patching
   and no `Append` special case was needed.
3. **Answered (2026-09-04).** No coverage gaps found. 37 SymPy constructs were rendered through the real
   pipeline with **zero** KaTeX errors, including all three the concern named: `\begin{cases}` (`Piecewise`),
   `\limits` (definite integrals, `Sum`, `Limit`) and `\operatorname` (`asin`, `atan`). Also `Matrix`,
   `Dict`, `Tuple`, `Rational`, nested radicals, fractional exponents, Greek symbols, `oo`, `Derivative`,
   applied functions, series with `O()`, and a long polynomial expansion (which wraps rather than
   overflowing, so the page never scrolls sideways). Re-run this on a KaTeX or SymPy bump: the printer and
   the renderer move independently.
4. **Answered.** See Q1 below: off on two deploys, on at uindy.

Also verified: `sympy.init_printing()` really replaces `sys.displayhook` outside IPython (the reason for
rejecting a displayhook design); `_repr_latex_` returns the `$\displaystyle …$` form; containers have no
`_repr_latex_`, confirming the `sympy.latex()` path.

---

## Appendix — review rationale (second-architect critique, 2026-09-03)

The plan above came out of an adversarial review of an earlier proposal. The verdicts, kept
so the reasoning is not lost:

1. **Surface.** Console-inline, not `#graphic`. The graphic pane is emptied every run
   (`pyodide.js:139`), the existing HTML box is `height:100%` and cannot stack (:1158),
   matplotlib appends into the same element (:2638), and the pane is `role="application"`
   (`pyodide.html:422`), which hides content from screen readers. Two changes to the original
   idea: a light output card so math reads on both the dark Run palette and the light REPL
   palette, and rich output must flow through the output buffer so ordering and the line cap
   hold.
2. **Interception point.** AST wrap of module-level `Expr` nodes compiled through
   `pyodide.code.CodeRunner`, never a second text-level rewrite on top of
   `_async_transform.py`. `sys.displayhook` was rejected because `sympy.init_printing()`
   replaces it outside IPython. The hook returning its argument removes the "final value
   becomes None, pandas breaks" problem entirely.
3. **Renderer.** KaTeX, vendored. MathML was rejected for classroom fidelity (rendering
   depends on the viewer having an OpenType math font; SymPy's MathML printer is weaker than
   its LaTeX printer). MathJax was rejected as heavier and awkward for streaming output; the
   "consistency with course material" argument is weak because the embed never loads MathJax
   today. Vendoring matters for exam-mode CSP direction and for html-to-image font embedding
   (same-origin CSS only). KaTeX's MathML output is the accessibility story; `sympy.pretty()`
   in an `aria-label` was rejected.
4. **Missed in the first proposal.** Four run pipelines, not two (main, worker, VPython,
   step-debugger recording); the worker is the intended default so main-only slices are
   invisible on such deploys; Clear memory restore semantics; REPL echo in both runtimes;
   stdout newline-batching ordering edge; containers of expressions; `_repr_latex_` return
   shapes; jqconsole `Append` insertion position unverified.
5. **Slicing.** The original slice 1 (`display()` plus last-expression hook, main thread only)
   was replaced by the slice 1 above, because bare-expression display on whichever runtime
   the deploy uses is the smallest thing a PICUP exercise actually benefits from.

Rejected alternatives from the first proposal, for the record: matplotlib mathtext to PNG
(LaTeX subset; chokes on matrices and cases), `init_printing(use_unicode=True)` ASCII art
(not what was asked), a minimal `_repr_latex_` branch in `renderRichResult` only (last
expression only, wrong pane, ordering lost).

---

## Answers from the PICUP team (running log)

Q1, Q2, Q5, Q7 and Q8 are answered from the three production deploys and the runtime. Q3, Q4, Q6 and Q9 were decided by Andrew (2026-09-03/05); nothing is
Andrew's calls and still open. Andrew is merging PRs on 2026-09-03, so the base-branch notes at the end are
dated.

### Q1 — `features.workerRuntime`: depends on the deploy

| Deploy | workerRuntime |
|---|---|
| picup VPS (trinket.gopicup.org) | false |
| mandi | false |
| uindy | **true** |

`default.yaml:16` ships `false`; uindy overrides it. Production config lives in the `gopicup-deploy-config`
repo, which deep-merges over `config/default.yaml`; a flag change there needs an image rebuild (under
`docker-compose.prod.yml` the overlay is baked in). The per-trinket `?runtime=worker` override works on any
deploy (`runtime-router.js:69-74` checks the query above the config gate).

**Consequence: worker parity stays in slice 1.** A main-thread-only slice would work on Andrew's VPS and
silently do nothing at uindy. (An earlier revision of this log, based on the VPS alone, moved the worker to
slice 2; that is withdrawn.) `features.mathOutput` will need the same overlay edit and rebuild on each deploy
where it should be on.

### Q2 — calculator mode is glowscript-only; CSP is on everywhere

`calculatorOption: [glowscript]` (`default.yaml:479`), so Python exam embeds do not exist yet; a Python
calculator layout is separate scope on Steve's backlog. But a real `Content-Security-Policy` header is served
on `/embed/python3` by all three deploys, so anything CDN-loaded would need a policy change regardless.
Vendoring sidesteps that.

### Q3 — vendor KaTeX: **decided, vendored** (Andrew, 2026-09-05, on PR #239)

Kept as implemented. Andrew's ranking of the arguments, recorded because they are not equally strong:
the **snapshot rasterizer** is the deciding one and is sufficient alone (html-to-image inlines
`@font-face` only from same-origin stylesheets, so a CDN KaTeX would produce library/example thumbnails
with the equations stripped of glyphs, and no configuration can fix that); the CSP argument is the
softest (the live policy already permits cdnjs and jsDelivr in `script-src`, `style-src` and `font-src`;
emptying `cdnOrigins` is a direction, not a constraint); classroom network blocking is real but soft;
the ~6% size figure is accepted. Caveat to carry: on the picup VPS static assets are served `no-store`
(**#171**, "Static assets are served with no-store — every page load re-downloads 4.4 MB of immutable
JS"), so the lazy ~300 KB is re-fetched on every load of a typesetting trinket until that is fixed. The
same is true of the 6.6 MB already re-sent, so it does not change vendor-vs-CDN. Earlier revisions of
this document cited #234 for the no-store issue; #234 is the cache-prefix follow-up ("client-built URLs
still bypass the cache prefix"), and the correct reference is #171.

Sizing context: a cold session already pulls 6.89 MB, 96% from `/components/`. Vendored also means
same-origin, which the snapshot rasterizer needs for font embedding. Assets must be referenced under
`/cache-prefix-<commit>/` (PR #233's pattern), which slice 1 does.

### Q4 — typeset Instructions: **decided, not in slice 1; open as its own issue** (Andrew, 2026-09-05)

Andrew confirmed the wart (course pages carry MathJax; `embed/base.html` and `embed/pyodide.html` carry
none) and wants it fixed, as a separate issue, for three reasons: it changes the loading profile (KaTeX
would move from lazy-on-first-typeset to the critical path of every embed containing a `$`, a fresh
fetch per load while #171 stands); it is a different trust surface (instructor-authored markdown, not
escaped student output; deserves its own escaping and allowed-sequence decisions); and it would overload
one flag (enabling typeset console output must not silently change how years-old instructor content
renders). Two independent decisions, so two flags or at least two rollouts.

Findings from a second review (2026-09-05) that the issue must carry:

- The embed loads the **legacy** markdown parser (`lib/views/embed/pyodide.html:540` →
  `public/js/trinket-markdown.js`), which protects only `$$`, `$(` and `)$` from marked
  (`trinket-markdown.js:434`). Single-dollar `$x_1$` is mangled to italics before any renderer sees it.
- Course pages do **not** enable single-dollar inline math either: MathJax `inlineMath` is
  `[['$(',')$'], ['\\(','\\)']]` (`lib/views/base.html:208`). The house inline delimiter is `$( … )$`.
- Course pages load a **siunitx** extension for MathJax (`base.html:213-216`). KaTeX has no siunitx, so
  `\SI{9.8}{\metre\per\second\squared}` would render on the course page and fail in the embed. For a
  physics deployment this is the main consistency hazard, and it is instructor-authored TeX.
- Instructions exist on all nine embed types (`includes/embed-instructions.html`), not only Python; the
  fix must not ride on `features.mathOutput` or the Python-only asset injection.
- No double-typesetting risk: `#instructionsOutput` is rendered only inside the embed iframe.

Recommendation for the issue: own flag; all embed types; delimiter set matched to the house set
(`$$`, `$( )$`, `\( \)`, `\[ \]`); and a deliberate engine choice that weighs siunitx. The honest option
is MathJax for Instructions (the same build and config the course pages use, already CSP-allowed) and
KaTeX for SymPy output; that contradicts "one renderer" but buys parity with course material.

### Q5 — Pyodide 0.28.1 on all three deploys; ceiling is 0.29.4

Pyodide 0.31.x dropped classic Web Workers and `pyodide-worker.js` uses `importScripts`, so **0.29.4 is the
practical ceiling** until the worker is converted to a module worker. SymPy on 0.28.1 is **1.13.3** and
auto-loads on import in about **3.3 s**; the first typeset expression waits on that plus KaTeX, hence the
loading notice in slice 1.

**Addendum (later on 2026-09-03).** Pyodide 0.28.1 gives students **Python 3.13.2** (checked on the running
embed); `ast.get_source_segment`, which the source echo uses, is present. Pyodide has renumbered to track
CPython: `0.29.4` → `314.0.0` → `314.0.6` (Python 3.14). The 0.29.x cap comes from `importScripts`; **#215**
has a verified fix, a module worker loading `pyodide.mjs` that boots on 0.28.1, 0.29.4 and 314.0.6, so the
conversion is backward compatible and can land before any version bump. Consequences: SymPy will move past
1.13.3, so do not hard-code the SymPy version and re-check the LaTeX printer output on upgrade; and the AST
wrap is the version-sensitive part of slice 1, so run its pure-Python tests under **3.13 and 3.14** from the
start (cheap now, annoying to retrofit). Do not lean on 3.13-only `ast` behaviour.

### Q6 — deploy config vs per-trinket: **decided, deploy config; per-trinket closed** (Andrew, 2026-09-05)

Deploy config is right, and Andrew closes the door on per-trinket rather than deferring it: per-trinket
settings earn their place when trinkets within one course legitimately need to differ, and this is not
that. Inconsistent rendering between assignments in one course is worse than either setting applied
uniformly, and a flag saved into the trinket travels on copy and export, producing "why does maths render
in the original and not in my copy?" support questions. The escape hatch that matters exists at program
level and is the one students learn anyway: `display()` to force a card, trailing `;` to suppress. If
instructors ask for control, expect the request to be **course-level**, not per-trinket (precedent:
`course.globalSettings.markdownEngine`, `lib/models/course.js:30-35`; the embed does not currently know
its course, so this needs plumbing and is noted, not built).

Second-review notes that agree: no URL override for this feature (the runtime router's own rule is that
the flag is the only gate and a query string must not opt a class in; math output has no false-positive
case that would justify one, and students edit URLs); the source-line echo and the copy format are viewer
preferences (per-user settings modal or `localStorage`), not trinket settings; and since a production
flag change costs an image rebuild while the dev stack already forces the flag on
(`docker-compose.gcr.yml:76`), defaulting `mathOutput` to true upstream once trials pass, keeping it as a
kill switch, is the lower-friction path. Not before worker parity lands, or uindy advertises a feature
that does nothing.

**Andrew's gate before enabling on trinket.gopicup.org:** the deploy-wide flag is safe only because the
feature is a byte-for-byte no-op for existing trinkets (bare ints, strings, plain lists and matplotlib
return values all silent). That property is testable rather than arguable: he will run a set of real
PICUP python3 trinkets on staging with the flag on and confirm the console output is unchanged. Not a
blocker for merging slice 1 behind the default-off flag.

### Q7 — embed snippet emits no `allow=` attribute (confirmed)

Subtlety: the pyodide embed is same-origin with its host page (unlike glowscript, which is a sandboxed
`srcdoc` frame), so the async clipboard works on a trinket page and will not inside an LMS. The download
fallback stands.

### Q8 — cap: **answer revised after measurement** (2026-09-04)

The original answer was: `console-buffer.js:31`, `maxLines` 5000, system text exempt, and one math
block = one line fits the accounting. That was decided before anyone had rendered a card, and
measurement during slice 1 showed it does not hold.

Measured end-to-end on a `make gcp` stack (Apple Silicon, Pyodide 0.28.1, SymPy 1.13.3, KaTeX
0.18.5), 400 iterations of `display(e)` on a **warm** interpreter, A/B against the same build with
the budget lifted:

| budget | typeset cards | worst freeze | total blocking |
|---|---|---|---|
| unbounded (shared 5,000-line budget) | 400 | 2,093 ms | 6,697 ms |
| `maxRich: 30` | 30 | 1,253 ms | **1,528 ms** |

One extra typeset card costs **~14 ms** — KaTeX, 174 DOM nodes, ~6 KB of markup, one jqconsole
write — against microseconds for a line of text. The Python side is negligible: `_repr_latex_`
0.33 ms, `str()` 0.23 ms, `json.dumps` 0.008 ms, the JS crossing 0.015 ms; ~0.6 ms per result all
told. At the cap that is roughly **70 s** of unresponsive page, ~870,000 DOM nodes and ~29 MB of
markup — and while the main thread is blocked **Stop cannot fire**, which is precisely the failure
#142 and this cap exist to prevent. A `display()` inside a loop is the idiom the feature tells
students to use, so this is reachable by following the documentation.

**Implemented in slice 1:** a separate `maxRich`, default **30**, alongside the unchanged
`maxLines: 5000`. 30 is a readability limit rather than a performance one — nobody reads more than
a few dozen typeset equations, and the only realistic way to exceed it is a loop, where the student
never intended to read every result.

Past the budget results **degrade rather than being dropped**: each is written as an ordinary
console line carrying `str(expr)`, line number first. That costs microseconds, keeps every result
on screen and copyable, and reuses the plain-text path the KaTeX-unavailable case already
exercises. Because nothing is ever lost, the threshold is safe to set this low; the notice explains
what happened and what to do, once. Larry chose 30 over 50 on 2026-09-04.

**For Andrew:** the number is a one-line change (`maxRich` in `pyodide.js`'s `createOutputBuffer`
call, rationale and figures in `console-buffer.js`). Two caveats on the measurements. They are from
Apple Silicon; a classroom Chromebook is plausibly 3–5x slower, so the case for a low threshold is
stronger there, not weaker. And an earlier attempt at this measurement was wrong — a cold
`sympy.integrate()` dominated it and made the display path look ~10x more expensive than it is —
so the figures above are warm and A/B'd, and should be re-run if the renderer or Pyodide version
moves.

### Q9 — ordering of #215 against slice 1: **decided, #215 first** (Andrew, 2026-09-03 21:19)

#215 (module-worker conversion) and slice 1 both touch `pyodide-worker.js`. If #215 lands first, the worker
integration is written once against the module-worker shape; if after, someone rewrites it. Decide before
slice 1 starts. Recommendation from this document: **#215 first**, since it is backward compatible and small,
and slice 1's worker side is the `rich` sink plus the swap at the run call, both of which would otherwise be
written twice.

**Decision.** Andrew: clear the open PR queue, implement #215 (module worker, stays pinned at 0.28.1, no
behaviour change), then slice 1 starts. Steve's reasoning, for the record: #215 is not urgent as a bug but the
coupling with slice 1 is real and cheap to avoid by sequencing; it is verified backward compatible across
0.28.1 / 0.29.4 / 314.0.6; and `trinket-merge-test.web.app` (`workerRuntime: true`) is the test bed for the
worker path before it reaches uindy. The Python 3.14 bump remains a separate later decision.

**Effect on this plan.** Slice 1's worker side is written once, against the module-worker shape #215
produces; the swap point for the run call and the `rich` sink must be re-anchored in `pyodide-worker.js` after
#215 lands (the line pins above for that file will be stale). Base branch becomes plain `picup/main` once the
queue clears, so the integration-branch guidance below retires. The parts of slice 1 that do not touch the
worker (vendored KaTeX, the Python module, the buffer extension, main-thread wiring, tests) do not depend on
#215 and could start earlier if wanted; the sequencing decision is about the worker file.

### Nothing half-started

`features.mathOutput` does not exist anywhere yet.

### Base branch and where to develop (dated 2026-09-03; Andrew merging tonight)

`picup/main` was `0f9a07e` with nine PRs open. Pick the base by what has landed when work starts: most merged →
`picup/main`; some → the integration branch re-synced onto main; none → `trial/integration-2026-09-02`
(retires once the PRs land). The nine open PRs touch **none** of the eight files slice 1 needs (`pyodide.js`,
`console-buffer.js`, `pyodide-worker.js`, `worker-client.js`, `_async_transform.py`, `default.yaml`,
`Dockerfile`, `pyodide.html`), so rebasing is mechanical whichever base is chosen. Read #233 either way for the
cache-prefix pattern.

Deployed trials covering both runtimes:

| Trial | Runtime | Shape |
|---|---|---|
| rba-merge-trial.spvi.net | main thread | Cloud Run, Firestore/GCS |
| trinket-merge-test.web.app | worker | Cloud Run behind a CDN |
| trial-merge.spvi.net | main thread | compose/Mongo, mirrors the VPS |

### Still to check

Both items that stood here — jqconsole's insertion position relative to an armed prompt, and KaTeX coverage
of SymPy's printer output — were **answered on 2026-09-04** while implementing slice 1. See items 2 and 3
under "Unverified claims" above.

What remains open is not a question about the design:

- **Q3, Q4 and Q6** are decided (2026-09-05) and match the defaults slice 1 assumed (vendor KaTeX: yes,
  pinned at 0.18.5; Instructions not typeset; deploy-level config rather than per-trinket), so a different
  answer means a change, not a rewrite.
- **#215** (module worker) has not been started — it is an open issue, not a PR. Task 8, worker parity, is
  blocked on it, so on a deploy with `workerRuntime: true` (uindy) the feature currently does nothing.
- **The rich cap number.** 30 is implemented and measured (see Q8), but it is a product judgement about how
  many typeset results a student would ever read, not a fact. Easy to move: one argument in
  `pyodide.js`'s `createOutputBuffer` call.
