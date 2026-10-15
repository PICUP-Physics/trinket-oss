# PR #336 review follow-ups: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the review of #336 (Web VPython Stop button). Re-running after an edit becomes one click again, through a **↻ Run** look on the button, and three smaller review notes are taken care of.

**Architecture:** This plan goes on branch `stop-button` (PR #336).
- The controller (`glowscript-run-state.js`) is unchanged.
- A new *edited* presentation lives in the view (`run-stop-button.js` + `_run_stop.scss`), and `glowscript.js` drives it from the editor's existing `trinket.code.change` event.
- The runner shim gains two small guards.

**Tech Stack:** browser JS (UMD-lite modules, jQuery, ACE via `code-editor.js`), SCSS, Vitest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md`. This plan amends the button states, and Task 2 updates the spec to match.

## Why

The reviewer (sspickle, on #336, 2026-10-12) wrote that with Run turned into Stop, the classroom loop "edit, click Run" takes two clicks, Stop and then Run, for any looping program. Todd chose option A, and on 2026-10-12 approved this design:
- while the editor's code differs from what is running, the button shows **↻ Run**, and one click re-runs the changes;
- undoing back to the running code shows Stop again.

The other review notes:
- a namespaced `vp.rate()` test. A probe on the local stack showed that it runs and that Stop parks it; the `_async_transform` bug the reviewer had in mind is Pyodide-only.
- a one-line note on snapshots during stopping;
- accepting `glowscript.stop` only from the runner's parent;
- a continuation that settles once.

Todd also ruled that What's New stays untouched and that `.gitignore` stays local. The coordinator has already done both, in 51d33c6 and b6f53d3.

## Global Constraints

- **Branch `stop-button`. No push.** The coordinator pushes after Todd approves.
- **The button's outer width never changes**, including Stop ↔ ↻ Run ↔ Stop. The existing width hold in `run-stop-button.js` stays, and its content stays centered within 0.5 px.
- **What "edited" means:** `api.getValue()` (the serialized program, all files) `!==` the serialized text the current run launched with, which is `serializedCode` in `runCode()`.
  - It is re-evaluated on every `trinket.code.change` while the controller is `running`.
  - Equality, as after an undo, means Stop again.
- **Edited look:**
  - icon `fa fa-repeat`, label `Run`;
  - the normal (non-red) Run colours;
  - `data-action` `code.run`, set on both the attribute and jQuery's cached `.data('action')`;
  - aria-label `Run your changes`;
  - title / Foundation tooltip text `Run your changes (restarts the program).`;
  - no `aria-disabled`;
  - the strip keeps lapping, in the neutral grey `#6B6B6B`, not red;
  - class `run-state-edited`.
- **The edited look applies only in `running`.** `stopping` and `idle` look exactly as today, and any `set()` call clears the edited look. A new run starts not edited.
- **Clicking ↻ Run goes through the existing `code.run` path**, the same one Ctrl/Cmd-Enter uses: `runCode()` → `runState.launched()` → running. The 500 ms double-click guard is unchanged.
- **Untouched:** Pyodide, `default-toolbar.html` markup, `lib/views/static/whats-new.html`, `.gitignore`, the controller's state machine, and the error-banner code in `glowscript.js`.
- **No new dependency.**

## Review Focus

1. **Edit, then undo back to the exact running text:** Stop again. The comparison covers every file, not just the visible one.
2. **An edit during stopping:** no ↻ Run. After the stop the button is plain Run.
3. **↻ Run, then a second click within 500 ms:** ignored as a double-click, as today.
4. **Width:** constant across Stop → ↻ Run → Stop → Run, with the content centered.
5. **The runner's source check must not refuse the page's own stop,** in either sandbox mode: the embed page is the runner's direct parent in both. Template tests must post their stop from the parent.

---

### Task 1: Hardening and coverage from the review

**Files:**
- Modify: `public/js/embed/glowscript-stop-shim.js`
- Modify: `test/unit/glowscript-stop-shim.test.js`
- Modify: `test/unit/glowscript-runner-template.test.js` (only if its stop messages need a parent source)
- Modify: `test/browser/specs/glowscript-stop.spec.js`

**Interfaces:**
- Consumes: the shim's `install(win)` and `source()`, unchanged.
- Produces: the same interface.

- [ ] **Step 1: Write the failing shim tests.**
  1. **Settle once (1.1-2.7 style):** a wrapped continuation that the runtime calls twice settles only once. `pending` never drops below 0, and the program's continuation runs once.
  2. **Source check:** `'glowscript.stop'` from a source other than `win.parent` is ignored (not requested, nothing posted). From `win.parent` it works as today.
- [ ] **Step 2: Run them and watch them fail** for the expected reason.
- [ ] **Step 3: Implement both.**
  - Give the wrapped continuation a once-guard: settle and resume only on the first call.
  - In the message listener, return early unless `event.source === win.parent`.
  - Keep `install()` self-contained, because `source()` stringifies it: ASCII only, and no `</` sequence.
  - Add one line to the comment block above `allowWaits`: a Save while a stop is unconfirmed gets no window, so that save keeps no new thumbnail (spec, Known limits).
- [ ] **Step 4: Fix the template tests if needed.** If they dispatch `'glowscript.stop'` without a parent source, make them dispatch it from the runner window's `parent`; in jsdom that is the window itself when top-level. Run the four Stop-button unit files.
- [ ] **Step 5: Add a browser test, "a namespaced vp.rate() loop stops in place".**
  - Program: `Web VPython 3.2\nimport vpython as vp\nb = vp.box()\nn = 0\nwhile True:\n    vp.rate(30)\n    n = n + 1\n    print(n)\n`.
  - Poll until it has printed.
  - Wait past the double-click guard, then click Stop.
  - Expect Run again, `.glowscript-stopped-note` count 0 (parked, not torn down), and the printed output frozen over 1.5 s.
  - Run the spec on the local stack.
- [ ] **Step 6: Commit,** with your accurate co-author trailer.

### Task 2: ↻ Run after an edit (option A)

**Files:**
- Modify: `public/js/embed/run-stop-button.js` (the new edited presentation)
- Modify: `static/scss/embed/_run_stop.scss` (`.run-it.run-state-edited`)
- Modify: `public/js/embed/glowscript.js` (remember the launched text; drive the edited look from `trinket.code.change`)
- Modify: `test/unit/run-stop-button.test.js`
- Modify: `test/browser/specs/glowscript-stop.spec.js`
- Modify: `docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md`

**Interfaces:**
- Consumes: `create(elements, $)`, which returns `{ set(state), state() }`.
- Produces: the same, plus `edited(flag)` on the view.
  - While the view's state is `running`, `edited(true)` switches every control to the edited look and `edited(false)` switches it back to Stop.
  - In any other state it does nothing.
  - `set()` always clears the edited look.

**Behaviour:**
- **View.** `edited(true)` swaps the action, icon, label, aria-label, title/tooltip text and class to the edited look. `edited(false)` restores the Stop look exactly, with the same idempotence as `set()`.
  - The held width stays.
  - Re-center the content for whichever look is showing. Take its natural width from the inner content: the icon and label boxes plus their gap, or an equivalent. Never release the held width to measure.
  - Calling `edited()` with the current value does nothing.
- **SCSS.** `.run-it.run-state-edited` overrides the running state's red text, fill and focus colours with the normal Run look, keeps the strip lapping, and colours its stroke `#6B6B6B`.
  - Keep `:focus-visible` visible on the edited look.
  - Under `prefers-reduced-motion`, the static outline is grey too.
  - Check the cascade against `.run-state-running`, because both classes are present.
- **Wiring (`glowscript.js`).**
  - In `runCode()`, keep `serializedCode` in a module variable `launchedCode`, set before `runState.launched()` is called.
  - In `initialize`, register `$(document).on('trinket.code.change', …)`. When `runState && runState.state() === 'running'`, it calls `runButton.edited(api.getValue() !== launchedCode)`, inside try/catch with `console.warn`, the same fail-safe as `onState`.
  - The ↻ Run click needs no new code: `data-action` `code.run` goes through embed.js to `trinket.code.run`, then `showResult`, then `runCode()`.

- [ ] **Step 1: Write the failing unit tests** in `test/unit/run-stop-button.test.js`. Use the existing `layOut` stubs.
  - In running, `edited(true)` shows: icon `fa fa-repeat`, label `Run`, action `code.run` (attribute and jQuery cache), aria-label `Run your changes`, tooltip/title `Run your changes (restarts the program).` and class `run-state-edited`.
  - `edited(false)` restores the Stop look exactly.
  - `set('running')`, `set('stopping')` and `set('idle')` all clear the edited look.
  - `edited(true)` while idle or stopping does nothing.
  - The width stays held, and the content is re-centered: the padding fits the edited content.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement the view and the SCSS.**
- [ ] **Step 4: Implement the wiring** in `glowscript.js`.
- [ ] **Step 5: Rebuild the stack's CSS.** The stack serves CSS from inside the container. From the repo root, run `docker compose -f docker-compose.gcr.yml up --build -d -V`, then wait until `http://localhost:3001/` answers. The `-V` flag is required: without it, stale anonymous volumes serve old CSS.
- [ ] **Step 6: Add browser tests** to `glowscript-stop.spec.js`.
  - **Edit while running:** run a printing loop that prints `'A'`. Change the code so it prints `'B'`, using the ACE `setValue` the spec already uses. Expect:
    - the label `Run`, class `run-state-edited` and `data-action` `code.run`;
    - the same width as Stop.

    Then click. Expect the button to be Stop again, and new output to contain `B`.
  - **Undo back:** run, edit, then set the editor back to exactly the launched text. Expect Stop (class `run-state-running`, no `run-state-edited`).
  - Run the spec on the local stack.
- [ ] **Step 7: Update the spec.**
  - Button states: a "Running, code edited" row with the look above.
  - Transition table: an edit or undo while running.
  - Edge cases: an edit during stopping. Ctrl/Cmd-Enter is unchanged.
  - Known limits: after an edit, the button restarts rather than stops. To stop without restarting, undo the edit or stop the new run.
- [ ] **Step 8: Run the four unit files and the full suite once.** The suite needs `NODE_CONFIG='{"app":{"url":{"protocol":"https"},"plugins":{"session":{"cookieOptions":{"isSecure":true}}}}}' npx vitest run --hookTimeout=60000`.
- [ ] **Step 9: Commit** code + tests, then the docs, with your accurate trailer.
