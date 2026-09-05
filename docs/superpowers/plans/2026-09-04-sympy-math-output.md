# SymPy Typeset Output — Slice 1 Implementation Plan

> **For whoever executes this** — a person or an agent. Work task-by-task with checkbox
> (`- [ ]`) tracking. Two markers appear throughout, and both describe the work rather than
> any particular tool:
>
> - **[Sonnet-delegable]** — mechanical enough to hand off wholesale, with the task text as
>   the entire brief. Whoever owns the plan reviews the result.
> - **[Consult Fable]** — a call that is expensive to unwind. Stop, summarise the situation
>   and the options in a few lines, and get a second opinion before proceeding.
>
> The names come from how slice 1 was actually run (Claude Opus executing, Sonnet for the
> delegable tasks, Fable for second opinions). Read them as roles, not requirements.

**Goal:** When a student's Python trinket produces a SymPy expression as a bare top-level
expression (or via `display()`), the console shows the student's source line, numbered as in
the code window, with the expression typeset beneath it, interleaved in program order with
ordinary `print` output. Behind `features.mathOutput`, default off.

**Architecture:** One pure-Python module, installed into the interpreter at bootstrap in both
runtimes, wraps every module-level expression statement in a call to a hidden hook (AST
mutation through `pyodide.code.CodeRunner`, never a text rewrite). The hook returns its
argument, classifies it, and hands `{ latex, text, lineno, source }` to a sink. On the main
thread the sink is a JS callback; in the worker it is a posted `rich` message. The page
queues rich items through the existing output buffer so ordering and the line cap hold, and
renders them with vendored, lazily loaded KaTeX inside a light "output card".

**Tech stack:** Pyodide 0.28.1 (Python 3.13.2, SymPy 1.13.3), KaTeX (vendored), vitest (node
unit tests), Playwright (browser specs), nunjucks templates, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-03-sympy-math-output-design.md`. Read all of it,
including the "Answers from the PICUP team" log at the bottom, before Task 1. Line numbers in
the spec are pinned to `picup/main` at `66d7edc` (2026-09-04) and were verified unchanged
from `b3c156f`.

---

## Prerequisites and sequencing (decided by Andrew, 2026-09-03)

1. Andrew clears the open PR queue (**done**: zero PRs open, `main` is at `66d7edc`; #233 asset
   caching and #214 deploy test suite are both in) and deploys to production (planned 2026-09-04).
   Steve's later PR adding authenticated test routes for trial servers is test-only and touches
   nothing this plan changes.
2. **#215** (module worker: `pyodide.mjs` instead of `importScripts`) lands **before** the
   worker half of this plan. It is backward compatible and stays pinned at Pyodide 0.28.1.
3. Then slice 1 starts.

Tasks 1–7 touch nothing `#215` changes and may start before it merges. **Task 8 (worker
parity) must wait for #215** and must re-anchor its line references when it starts.

Base branch: `picup/main` (upstream `origin`). Work on a feature branch in your own fork,
e.g. `feature/sympy-math-output`, and open the PR against `PICUP-Physics/trinket-oss`.

## Formerly open items (all decided by Andrew on 2026-09-05; the assumptions below were confirmed)

| Item | Owner | Default assumed by this plan |
|---|---|---|
| Q3 vendor KaTeX | Andrew | **Yes, decided.** Deciding argument: snapshot font embedding needs same-origin CSS. Cite #171 (no-store), not #234. |
| Q4 typeset Instructions too | Andrew | **Not in slice 1, decided.** Own issue, own flag, all embed types; see the spec's Q4 entry for the parser/delimiter/siunitx findings. |
| Q6 deploy config vs per-trinket | Andrew | **Deploy config, decided; per-trinket closed.** Program-level `display()` / trailing `;` are the escape hatches. Gate before prod: no-op regression on real PICUP trinkets on staging. |
| KaTeX coverage of SymPy output | Steve offered | Task 6 includes a coverage probe; report gaps rather than work around them |

---

## Global constraints

- **Default off.** `config.features.mathOutput: false`. With the flag off, every code path is
  byte-for-byte today's behaviour. With it on and no SymPy in the program, behaviour is also
  unchanged: the hook returns its argument, so Pyodide's last-expression value and the
  existing `renderRichResult()` (`pyodide.js:1136`) keep working for pandas.
- **Only objects that can typeset themselves display.** `_repr_latex_` (SymPy `Printable`)
  and list/tuple/dict whose leaves are such objects. Ints, strings, matplotlib return values,
  module docstrings and everything else stay silent. Never echo a `repr`.
- **Wrap only module-level `ast.Expr` nodes.** Nothing inside `if`/`for`/`while`/`with`/`def`/
  `class` bodies. `display()` is the escape hatch there, as in Jupyter.
- **AST mutation only, through `pyodide.code.CodeRunner`.** Never a second text rewrite on
  top of `_async_transform.py`'s `transform_source()`; parse its output instead. Keep
  `<exec>` as the filename so `formatPythonTraceback()` (`pyodide.js:900`) keeps working.
- **Never `sys.displayhook`.** `sympy.init_printing()` replaces it outside IPython (verified
  on the deployed embed). Students call it constantly.
- **Everything student-controlled is escaped.** The echoed source line and the `text` fallback
  go through `escapeConsoleHtml()` (`pyodide.js:334`). The LaTeX string goes only into
  `katex.renderToString` with `trust: false`, `throwOnError: false`, `maxExpand: 1000`. No
  Python string is ever concatenated into innerHTML.
- **Rich output flows through the output buffer** (`console-buffer.js`), never around it.
  Ordering with `print` and the 5,000-line cap are the whole point of that module; one math
  block counts as one line.
- **The worker never references `document`/`window`.** The `rich` message name is fixed and
  must be added to the protocol table in `2026-08-08-pyodide-worker-runtime-design.md` §4.
- **No hard-coded SymPy version.** Detect `_repr_latex_` at run time; only touch
  `sympy.latex()` when `'sympy' in sys.modules`. Never import SymPy yourself.
- **Python tests run under 3.13 and 3.14.** Pyodide is about to move to 3.14 (#215 lifts the
  cap); `ast` node shapes are the version-sensitive part of this slice.
- **Vendored KaTeX is referenced under the cache prefix** (`{{ '/components/…' | cachePrefix }}`
  in templates; see how PR #233 fixed the glowscript runner), never at a bare `/components/`
  path, which is served `no-store`.
- **Commit messages** end with `Co-Authored-By: Claude Opus <noreply@anthropic.com>` (or the
  model that wrote the commit). Small commits, one task each.

## Environment

- Node unit tests: `npm test` (vitest; `test/unit/*.test.js`). For local browser runs, add
  `mathOutput: true` to `config/local.yaml` alongside whatever else you have enabled there
  (`variableExplorer`, say). That file is gitignored (`.gitignore:36`), so it stays local —
  the deploy-facing default lives in `config/default.yaml`.
- Python tests: `python3 test/lib/embed/test_trinket_display.py` (created in Task 3), same
  shape as `test/lib/wvpython/test_async_transform.py`, and registered in
  `.github/workflows/test.yml` next to it (line 33) under a 3.13 / 3.14 matrix.
- Browser specs: `docker compose -f docker-compose.gcr.yml up -d --build`, then
  `cd test/browser && npx playwright test specs/<file>`. After editing anything under
  `public/js/` or `static/scss/`, rebuild the container before specs see it. Do **not** run
  `test/browser/run-smoke.sh` (it tears the stack down on exit).
- Vendored assets for local dev: `npm run setup-vendor` plus the new `scripts/sync-katex.sh`
  (Task 2). `public/components/` is gitignored; never commit anything under it.
- Pyodide boots from jsDelivr (~10 MB) and SymPy imports in ~3.3 s; browser specs need the
  same generous `toPass({ timeout: 90_000 })` pattern `clear-memory.spec.js` uses.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `public/js/embed/_trinket_display.py` | **Create** | The Python module: `display()`, classifier, AST wrap, runner, sink protocol. Pure stdlib + `pyodide.code`. Testable outside Pyodide except the runner. |
| `test/lib/embed/test_trinket_display.py` | **Create** | Pure-Python tests for wrap/classify, run under 3.13 and 3.14. |
| `public/js/embed/console-buffer.js` | **Modify** | Queue holds text and rich segments; `drain()` returns segments; rich counts against the cap. |
| `test/unit/console-buffer.test.js` | **Modify** | Ordering and cap tests for rich segments. |
| `public/js/embed/pyodide.js` | **Modify** | Bootstrap install (before the baseline snapshot), main-thread sink, run-path swap, `ensureKatex()`, `renderMathCard()`, flush of rich segments, loading notice. |
| `public/js/embed/pyodide-worker.js` | **Modify (Task 8, after #215)** | Boot-time install, worker sink posting `rich`, run-call swap. |
| `public/js/embed/worker-client.js` | **Modify (Task 8)** | Dispatch `rich` scoped to the current run, like `figure`. |
| `lib/views/embed/base.html` | **Modify** | Expose `mathOutput` in `window.trinket.config` (next to `workerRuntime`, line ~43). |
| `lib/views/embed/pyodide.html` | **Modify** | Emit cache-prefixed KaTeX URLs into a small config object when the flag is on. |
| `static/scss/embed/_python.scss` | **Modify** | `.math-card` styles: light card, echo line, `white-space: normal`. |
| `config/default.yaml` | **Modify** | `features.mathOutput: false` with a comment. |
| `Dockerfile`, `scripts/sync-katex.sh`, `COMPONENTS.md`, `scripts/deploy-hosting.sh` | **Modify / Create** | Vendor KaTeX pinned by version + sha256; make sure hosting publishes it. |
| `test/browser/specs/math-output.spec.js` | **Create** | End-to-end: cards in order, line numbers, `print` interleaving, flag-off no-op. |
| `docs/superpowers/specs/2026-08-08-pyodide-worker-runtime-design.md` | **Modify (Task 8)** | Add `rich` to the worker→page table. |
| `CHANGELOG.md` | **Modify** | Entry under Unreleased. |

Estimated size: about 650 new lines across these files, roughly 150 Python, 250 JS, 40 SCSS,
200 tests, and a few dozen lines of config, Docker and docs. `pyodide.js` grows by about 3%.

---

## Task 1: Feature flag and plumbing **[Sonnet-delegable]**

**Files:** `config/default.yaml`, `lib/views/embed/base.html`, `lib/views/embed/pyodide.html`.

- [ ] Add to `features:` in `config/default.yaml` (after `workerVPython`, line 17):
  ```yaml
  mathOutput: false  # Typeset SymPy output (Jupyter-style) in the Pyodide console: bare top-level expressions and display() render via vendored KaTeX. See docs/superpowers/specs/2026-09-03-sympy-math-output-design.md
  ```
- [ ] In `lib/views/embed/base.html`, next to `workerRuntime` (~line 43), add
  `mathOutput : {{ 'true' if config.features.mathOutput else 'false' }},`.
- [ ] In `lib/views/embed/pyodide.html`, inside `{% block body_scripts %}` before the
  `cachify_js` lists, add:
  ```html
  {% if config.features.mathOutput %}
  <script>window.__TRINKET_KATEX__ = {
    js : '{{ "/components/katex/katex.min.js" | cachePrefix }}',
    css: '{{ "/components/katex/katex.min.css" | cachePrefix }}'
  };</script>
  {% endif %}
  ```
  KaTeX's CSS references its fonts by relative path (`fonts/KaTeX_Main-Regular.woff2`), so the
  fonts resolve under the same prefix automatically.
- [ ] Verify: with the flag off, `window.__TRINKET_KATEX__` is undefined and
  `trinket.config.mathOutput === false`; nothing else on the page changed.
- [ ] Commit: `Add features.mathOutput flag and KaTeX asset config (off by default)`.

## Task 2: Vendor KaTeX **[Sonnet-delegable for the script; Opus reviews the Dockerfile and hosting change]**

**Files:** `Dockerfile`, `scripts/sync-katex.sh` (new), `COMPONENTS.md`, `package.json`,
`scripts/deploy-hosting.sh`.

Pattern to copy: the `VPYTHON_WHEEL_*` ARG block in the Dockerfile (~lines 68–90) and
`scripts/sync-vpython-worker.sh`, which parses those ARGs so the two fetch paths cannot drift.

- [ ] Pick the current KaTeX release. **Implemented as 0.18.5** — "0.16.x" was this plan's
  guess when it was written and is out of date; take whatever is current and pin it, rather
  than this number. The GitHub release asset `katex.tar.gz`
  contains `katex/katex.min.js`, `katex/katex.min.css`, `katex/fonts/*.woff2` (and `.woff`,
  `.ttf`). Compute its sha256 (`curl -fsSL <url> | sha256sum`).
- [ ] Dockerfile: add `ARG KATEX_VERSION=…` and `ARG KATEX_SHA256=…`, fetch the tarball with
  the same `$RETRY` flags, verify with `sha256sum -c -`, extract only `katex.min.js`,
  `katex.min.css` and `fonts/` into `public/components/katex/`. Keep only the `.woff2` fonts
  (modern browsers) unless the reviewer objects; note the choice in COMPONENTS.md.
- [ ] `scripts/sync-katex.sh`: same fetch for local dev, parsing the Dockerfile ARGs. Add it to
  `npm run setup-vendor` in `package.json` (currently `bash scripts/setup-glowscript.sh`;
  chain the two).
- [ ] `COMPONENTS.md`: add a row under the Python embed section: component, source
  (KaTeX GitHub release), version, sha256-pinned, "lazy-loaded only when a program typesets".
- [ ] **Hosting.** Read `scripts/deploy-hosting.sh` lines 50–70. It publishes `components/`
  selectively by crawling pages for referenced files, and lazily loaded assets are invisible
  to that crawl, which is why `RUNNER_PATHS` exists. Add `components/katex` to that list (or
  the equivalent mechanism the script uses today after #231/#233). **[Consult Fable]** if the
  script's mechanism does not obviously cover a directory of fonts, before inventing a new one.
- [ ] Verify locally: `bash scripts/sync-katex.sh` produces the files; `curl -I` against the
  running stack for `/cache-prefix-<token>/components/katex/katex.min.css` returns 200 with
  the immutable cache header, and the bare `/components/katex/katex.min.css` also serves.
- [ ] Commit: `Vendor KaTeX (pinned, sha256-checked) for math output`.

## Task 3: The Python module and its tests

**Files:** `public/js/embed/_trinket_display.py` (new), `test/lib/embed/test_trinket_display.py`
(new), `.github/workflows/test.yml`.

This is the heart of the slice and the only version-sensitive part. Write it so that
everything except the Pyodide runner imports and runs under plain CPython.

- [ ] Module layout (keep it under ~200 lines):
  ```python
  """Typeset display hook for the trinket Pyodide runner. Pure stdlib except run_program()."""
  import ast, sys, builtins, linecache

  _HOOK_NAME = '__trinket_display_hook__'
  _sink = None            # callable(dict) installed by the host (JS callback or worker post)
  _source_lines = []      # main-file source, for echoing the student's line

  def install(sink, source=''):            # called by the host at bootstrap and per run
      global _sink; _sink = sink
      set_source(source)
      builtins.display = display
      builtins.__dict__[_HOOK_NAME] = _hook

  def set_source(source): ...              # split into lines once per run

  def _latex_of(obj):
      """Return a LaTeX string (no $ delimiters) or None. Never imports sympy."""
      # 1. _repr_latex_ → str | None | (data, meta) ; strip $…$ / $$…$$
      # 2. list/tuple/dict whose leaves all have _repr_latex_ → sympy.latex(obj) iff 'sympy' in sys.modules
      # 3. else None

  def _payload(obj, lineno=None, source=None): ...   # {'latex','text','lineno','source'} with text=str(obj) single line

  def _hook(value, lineno):                # wrapped around every module-level Expr
      latex = _latex_of(value)
      if latex is not None and _sink is not None:
          _sink(_payload(value, lineno, _line(lineno)))
      return value                         # keeps Pyodide's last-expression semantics

  def display(*objs):
      frame = sys._getframe(1)             # caller's line for the echo
      for o in objs: ...                   # same payload; lineno from frame, source via linecache/_source_lines;
                                           # prefix 'file.py:' when frame.f_code.co_filename is not the main program

  def wrap_module(tree):
      """Mutate a Module: each top-level Expr(value) -> Expr(Call(hook, [value, lineno])). Returns tree."""
      for i, node in enumerate(tree.body):
          if isinstance(node, ast.Expr):
              call = ast.Call(func=ast.Name(id=_HOOK_NAME, ctx=ast.Load()),
                              args=[node.value, ast.Constant(node.lineno)], keywords=[])
              new = ast.Expr(value=call)
              ast.copy_location(call, node.value); ast.copy_location(new, node)
              tree.body[i] = new
      ast.fix_missing_locations(tree)
      return tree

  async def run_program(source, globals_, filename='<exec>'):
      """Pyodide only. source is the ALREADY async-transformed program text."""
      from pyodide.code import CodeRunner
      import ast as _ast
      runner = CodeRunner(source, mode='exec', filename=filename,
                          flags=_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
      wrap_module(runner.ast)
      runner.compile()
      return await runner.run_async(globals_)
  ```
  Notes for the implementer: the `Await` inside a wrapped `Expr` (e.g. `await rate(30)` after
  the async transform) is legal as a call argument; the hook receives `None` and ignores it.
  Do not touch `ast.Expr` nodes that are the first statement and a `Constant` string if you
  want to be conservative about docstrings, but the classifier already ignores strings, so
  wrapping them is harmless. Never call `ast.unparse`.
- [ ] **[Consult Fable]** before finalising `run_program()` if `CodeRunner` on the deployed
  Pyodide does not expose `.ast` exactly as assumed, or if `run_async` returns something other
  than the last-expression value. (Steve verified `.ast` is assignable and `compile()` after
  mutation works; `run_async` exists. The return-value semantics were not probed.)
- [ ] Tests in `test/lib/embed/test_trinket_display.py` (load the module by path like
  `test_async_transform.py` does; stub `sys.modules['pyodide']` is not needed because
  `run_program` imports lazily). Cover:
  - wraps every module-level `Expr`, none inside `if`/`for`/`def`/`class`, docstring included;
  - `lineno` passed to the hook equals the original statement's line; `end_lineno` intact;
  - compiles and executes under `exec()` with a recording sink; hook returns its argument
    (`x = 1; x` style programs still yield the value when run through
    `compile(tree, '<exec>', 'exec')` plus an explicit last-expression check);
  - composes with `_async_transform.transform_source()` output containing top-level `await`
    (compile with `PyCF_ALLOW_TOP_LEVEL_AWAIT`; assert the wrapped tree compiles);
  - classifier: object with `_repr_latex_` returning `'$x$'`, `'$$x$$'`, `None`, and
    `('$x$', {})`; list of such objects when a fake `sympy` module with `latex()` is in
    `sys.modules`; ints, strings, plain lists return `None`; `sympy` is never imported by the
    module (assert `'sympy' not in sys.modules` after the tests that do not stub it).
- [ ] `.github/workflows/test.yml`: run the new file next to line 33 under a matrix of
  `python-version: ['3.13', '3.14']` (3.14 may need `allow-prereleases: true` depending on the
  runner image). **[Sonnet-delegable]**
- [ ] Commit: `Add _trinket_display: AST display hook and classifier, with 3.13/3.14 tests`.

## Task 4: Main-thread integration

**Files:** `public/js/embed/pyodide.js`.

- [ ] **Bootstrap install, before the baseline snapshot.** In `ensurePyodide()` where
  `console.py` is written (~line 640) and before the `__trinket_baseline__` block (~652–662):
  fetch `/js/embed/_trinket_display.py` (use the same URL style as `ASYNC_TRANSFORM_URL`,
  line 1023) and `py.FS.writeFile('_trinket_display.py', src)`, then
  `py.runPython('import _trinket_display')`. Because this happens before the snapshot, Clear
  memory (`clearMainThreadMemory`, line 2594) restores a namespace that still has it, and the
  `builtins` install is outside `globals()` anyway. Guard the whole thing on
  `trinket.config.mathOutput`; the flag off must not fetch anything.
- [ ] **Sink.** Define `window.__trinket_rich = function(json) {…}` that parses the payload and
  calls `queueMathCard(payload)` (Task 5/6). In Python, install with
  `_trinket_display.install(lambda p: js.__trinket_rich(json.dumps(p)))` (do the `json.dumps`
  in Python so no PyProxy crosses; mirror the `snapshot` JSON pattern the explorer uses).
- [ ] **Run-path swap.** In `startRun()` (line 2864) there are three `pyodide.runPythonAsync(…)`
  call sites for the program: the matplotlib branch (~2967), the console-transform branch
  (~2989) and the plain fallback (~2991). Introduce one helper:
  ```js
  function runProgram(src) {
    if (!mathOutputEnabled()) return pyodide.runPythonAsync(src || '');
    pyodide.globals.set('__user_source__', src || '');
    return pyodide.runPythonAsync(
      'import _trinket_display as _d\n' +
      '_d.set_source(__user_source__)\n' +
      'await _d.run_program(__user_source__, globals())\n');
  }
  ```
  and call it from all three sites with the (possibly async-transformed) source. The returned
  value is still the last-expression value, so `renderRichResult(result)` at line 2997 is
  untouched. Check that `__user_source__` is already in the Variables explorer's `_SKIP` set
  (it is, `VARS_HELPER` line ~1170).
- [ ] **Do not** touch `runVpython()` or the step-debugger recording pipeline in this slice
  (spec slice 2). Add a one-line comment at each pointing to the plan.
- [ ] Verify by hand in the browser (flag on, `?runtime=main`): a program
  ```python
  import sympy as sp
  t, w = sp.symbols('t omega', positive=True)
  x = sp.Function('x')
  print("Simple harmonic oscillator")
  eq = sp.Eq(x(t).diff(t, 2), -w**2 * x(t))
  eq
  sol = sp.dsolve(eq, x(t)); sol
  print("Period:", 2*sp.pi/w)
  ```
  calls the sink twice with `lineno` 6 and 7 and the right `source` strings (an earlier
  revision of this plan said 6 and 8, which is a miscount of the eight-line program above:
  the bare `eq` is line 6 and `sol = ...; sol` is line 7) (log them to the
  console for now). A program with no SymPy calls it zero times. Clear memory then re-run
  still works.
- [ ] Commit: `Install the display hook at bootstrap and route main-thread runs through it`.

## Task 5: Rich segments in the output buffer

**Files:** `public/js/embed/console-buffer.js`, `test/unit/console-buffer.test.js`,
`public/js/embed/pyodide.js` (`flushConsoleNow`).

- [ ] Extend `createOutputBuffer()`:
  - `pushRich(item)`: subject to the cap like `pushStream`, counting **1 line**; when capped,
    drop it (the existing notice already explains the cap); returns boolean like `pushStream`.
    **Superseded during implementation — see the spec's revised Q8.** Measurement showed one
    typeset card costs ~14 ms against microseconds for a text line, so sharing the 5,000-line
    budget allowed ~70 s of unresponsive page, during which Stop cannot fire. As built, rich
    output has its **own** budget (`maxRich`, 30) and past it results **degrade to plain text
    rather than being dropped**, so nothing is lost.
  - Internally the queue becomes a list of segments `{ text: string } | { rich: item }`;
    adjacent text segments are merged on `drain()`.
  - `drain()` now returns an **array of segments**. Keep `drainText()` returning the old joined
    string for any caller that only wants text (there is one today: `flushConsoleNow`, which
    you are changing anyway). **[Consult Fable]** only if another caller of `drain()` turns up
    that makes the contract change non-trivial; otherwise proceed.
- [ ] Unit tests: rich between two text pushes drains in order; rich counts against the cap
  and is dropped after it; `pushSystem` still bypasses the cap; `resetCap()` unaffected.
  **[Sonnet-delegable]** once the API above is fixed.
- [ ] `flushConsoleNow()` in `pyodide.js` (~line 195): iterate segments; text goes through the
  existing single `jqconsole.Write(text)`; a rich segment calls `renderMathCard(item)` (Task
  6). Keep one reflow per frame as the goal: build the card DOM first, then insert.
- [ ] `queueMathCard(payload)` = `outBuf.pushRich(payload); outScheduleFlush();` (and
  `initConsoleOutput()` first, like `writeStream`).
- [ ] Commit: `console-buffer: carry rich segments in order and under the cap`.

## Task 6: Rendering — KaTeX loader, the card, the loading notice, styles

**Files:** `public/js/embed/pyodide.js`, `static/scss/embed/_python.scss`.

- [ ] `ensureKatex()`: memoised like `ensureGlow()` (line 961). Reads
  `window.__TRINKET_KATEX__`; injects `<link rel=stylesheet>` and `<script>`; resolves when
  `window.katex` exists; on failure resets the memo (so a transient error can retry, as
  `ensureConsoleTransform` does) and rejects. On **first** call, `writeOut('Loading math…\n')`
  in the style of `Loading packages…`.
- [ ] `renderMathCard(item)`: builds
  ```html
  <div class="math-card">
    <div class="math-echo"><span class="math-ln">6</span><span class="math-src">eq</span></div>
    <div class="math-body">…katex html…</div>
  </div>
  ```
  `math-ln` and `math-src` are filled with `textContent` (never innerHTML) or via
  `escapeConsoleHtml()`. `math-body` gets `katex.renderToString(latex, { throwOnError: false,
  trust: false, maxExpand: 1000, displayMode: false, output: 'htmlAndMathml' })`. If KaTeX is
  not loaded yet, render the card with `math-body` holding the escaped `text` fallback, then
  upgrade it in place when `ensureKatex()` resolves (so ordering never waits on the network).
  If KaTeX fails to load, the text fallback stays; that is the degraded mode.
- [ ] **Insertion point (open item #2 from the spec).** First try
  `jqconsole.Write(html, 'math-card-wrap', false)`, which is the path every other console
  write uses and already handles an armed REPL prompt. Only if the block-in-span markup
  misbehaves, try `jqconsole.Append(html)` and confirm where it lands relative to a live
  prompt (open the REPL, arm a prompt, append). Record the answer in the spec's "Still to
  check" list. **[Consult Fable]** if neither gives correct placement without patching
  jqconsole.
- [ ] Styles in `static/scss/embed/_python.scss`, scoped under the existing console selectors:
  light card background (`#fff`), dark text, 6px radius, 8–12px padding, `white-space: normal`
  (the console ancestor is `pre-wrap`, line 255), echo line in the console's monospace at
  ~0.9em muted, line number right-aligned in 2ch with `font-variant-numeric: tabular-nums`,
  math body indented ~26px. Must read on both the dark Run palette (`.jqconsole-output`
  white, line 317) and the light `.console-mode` REPL palette. Rebuild CSS
  (`npm run build:css`). **[Sonnet-delegable]**
- [ ] **Coverage probe** (open item #3). Run a fixed list of SymPy expressions through the
  real pipeline once KaTeX renders: `Integral`, `Derivative`, `Sum`, `Matrix`, `Piecewise`
  (`\begin{cases}`/`array`), `Rational`, `sqrt`, `exp`, `Abs`, `atan2`, a `Dict`, a
  `Tuple`, `Eq`, `oo`, Greek symbols, `Function('x')(t)`. Anything KaTeX renders in the error
  colour goes into a list in the PR description and the spec, not into a workaround.
- [ ] Verify by hand: the Task 4 program renders two cards between the two prints, in order,
  numbered 6 and 7; the second
  card shows the two-statement line `sol = dsolve(eq, x(t)); sol`
  in full. A program printing 6,000 lines then displaying an expression shows the cap notice
  and no card. Resize the pane; cards wrap, the page never scrolls sideways. Dark and light
  palettes both legible.
- [ ] Commit: `Render typeset math cards in the console with vendored KaTeX`.

## Task 7: Browser spec

**Files:** `test/browser/specs/math-output.spec.js` (new), test config.

- [ ] Find how specs turn features on for the compose stack (the Variables specs rely on
  `variableExplorer`; check `config/test.yaml` and `docker-compose.gcr.yml` env). Enable
  `mathOutput` the same way. **[Sonnet-delegable]** for the config plumbing.
- [ ] Spec (`?runtime=main`), modelled on `clear-memory.spec.js`:
  1. the Task 4 program → `#console-output` contains two `.math-card` elements, in DOM order
     after the first `print` text and before the second; `.math-ln` texts are `6` and `7`;
     `.math-body .katex` exists (KaTeX rendered, not fallback);
  2. a program with a bare `42` and a bare string → zero `.math-card`, console text unchanged
     from today;
  3. `display(expr)` inside a `for` loop → three cards with the same line number;
  4. Clear memory, re-run → cards render again (module survived the reset).
  Use `toPass({ timeout: 90_000 })` for the first assertion (Pyodide + SymPy load).
- [ ] Run the existing `repl.spec.js`, `clear-memory.spec.js`, `stop.spec.js`,
  `traceback.spec.js` and `input.spec.js` with the flag **on**; all must still pass (the
  hook must not perturb tracebacks, input, or stop).
- [ ] **Deploy suite (#214).** `test/browser/playwright.deploy.config.js` runs specs against a real
  deploy. Add one math-output case there, gated on the target deploy having `mathOutput` on, so
  the trial on `trinket-merge-test.web.app` is a recorded check rather than a manual look.
  **[Sonnet-delegable]** once the local spec passes.
- [ ] Commit: `Browser spec for typeset math output`.

## Task 8: Worker parity — **only after #215 has merged** **[Consult Fable before starting]**

**Files:** `public/js/embed/pyodide-worker.js`, `public/js/embed/worker-client.js`,
`public/js/embed/pyodide.js`, `docs/superpowers/specs/2026-08-08-pyodide-worker-runtime-design.md`.

- [ ] **Re-anchor.** #215 rewrites how the worker is created and loaded. Re-find: where the
  worker boots Pyodide and sets stdout (was `pyodide-worker.js:103`), where the program is
  executed (was `.then(function(src) { return pyodide.runPythonAsync(src); })`, line 573),
  the `figure` post helper (was 217), and the `init` message handling (`varsHelper` is passed
  from the page, `worker-client.js` `ensureWorker`). Summarise what moved for Fable in five
  lines, then proceed.
- [ ] **Boot-time install.** The page owns the module source (fetch it once in `pyodide.js`
  and pass it on the `init` message, exactly as `varsHelper` is passed) so both runtimes run
  byte-identical Python. The worker writes it to its FS and imports it at boot when the flag is
  on (send the flag on `init` too).
- [ ] **Sink.** `self.__trinket_worker_rich = function(json) { post({ type: 'rich', id: currentRunId, payload: JSON.parse(json) }); }`
  and in Python `_trinket_display.install(lambda p: js.__trinket_worker_rich(json.dumps(p)))`.
- [ ] **Run swap.** Replace the `runPythonAsync(src)` call for the program with the same
  `run_program` snippet Task 4 uses, guarded on the flag. The `MPL_FLUSH` step and the
  `done`/`error` replies are unchanged.
- [ ] `worker-client.js`: dispatch `rich` **scoped to the current run**, exactly like
  `figure` (lines 70–73): `if (msg.type === 'rich') { if (!current || msg.id !== current.id) return; if (opts.onRich) opts.onRich(msg.payload); return; }`.
- [ ] `pyodide.js`: in `ensureWorkerClient()` options (~line 2127) add
  `onRich: function(p) { queueMathCard(p); }`.
- [ ] Spec §4 table: add `rich | { id, payload: { latex, text, lineno, source } } | typeset display item; page renders`.
  Do not bump `PROTOCOL_VERSION`: an old page ignores unknown types, and an old worker never
  sends it.
- [ ] Browser spec: parametrise `math-output.spec.js` over `?runtime=main` and
  `?runtime=worker` (see how `worker-runtime.spec.js` does it). Ordering test with
  `print("x =", end="")` immediately before a displayed expression documents the known
  newline-batching edge rather than asserting perfection.
- [ ] Trial on `trinket-merge-test.web.app` (worker, behind a CDN) before anything reaches
  uindy.
- [ ] Commit: `Worker parity for typeset math output (rich message)`.

## Task 9: Documentation, rollout notes, PR

- [ ] `CHANGELOG.md` Unreleased entry; `COMPONENTS.md` row (Task 2); a short paragraph in the
  spec's status line ("slice 1 implemented in PR #…").
- [ ] Update the spec's "Still to check" with the answers found in Tasks 6 and 8.
- [ ] PR against `PICUP-Physics/trinket-oss` from the fork branch. Description: what a
  student sees (paste the Task 4 program and a screenshot), the flag, the rollout steps
  (overlay edit in `gopicup-deploy-config` + image rebuild per deploy; trial on
  trinket-merge-test first), the assumptions taken on Q3/Q4/Q6, the KaTeX coverage findings,
  and the slice 2 list below. **[Consult Fable]** for a final review pass of the diff before
  requesting Andrew's review.

---

## Verification matrix (run before the PR)

| Check | How |
|---|---|
| Flag off is a no-op | Diff console text for the Task 4 program and for `traceback.spec.js` inputs with flag off vs `main` |
| Ordering | Task 7 case 1 |
| Cap | 6,000 prints then a display → notice, no card |
| Clear memory | Task 7 case 4 |
| REPL unaffected | `repl.spec.js` passes with flag on (REPL echo itself is slice 2) |
| Both palettes | Screenshot Run (dark) and Console (light) with a card |
| Snapshot | Owner run in editor layout; `captureAndSaveSnapshot` (line 3615) produces an image with glyphs (fonts embedded from same-origin CSS) |
| Python matrix | `test_trinket_display.py` green on 3.13 and 3.14 |
| Worker | Task 8 spec on `?runtime=worker`, and on trinket-merge-test |

## After the plan (slice 2 and later, from the spec)

REPL echo of `_repr_latex_` values (`pyodide.js:480`, worker REPL push); step-debugger
recording and `runVpython` pipelines through the same runner; pandas `_repr_html_` through the
card into the console; typeset Instructions (Q4); copy menu (LaTeX / Python / pretty / PNG via
html-to-image, with the `clipboard-write` caveat); per-trinket setting (Q6); stdout flush
inside the hook if the newline-batching edge bothers anyone in practice.
