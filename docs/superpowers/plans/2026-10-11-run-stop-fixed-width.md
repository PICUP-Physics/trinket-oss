# Run/Stop control keeps its size: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Web VPython Run control never changes size when it turns into Stop, or back. The interface changes as little as possible.

**Architecture:** This is a follow-up to the GlowScript Stop button, branch `stop-button`. Only the page-side view `public/js/embed/run-stop-button.js` changes, plus its tests and docs. The controller, the shim and the wiring stay as they are.

**Tech Stack:** browser JS (UMD-lite module), Vitest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md`. This plan amends its button-states wording and its width rule; Task 1 updates the spec to match.

## Why

Measured at a 1280 px viewport on the local stack, against the current code:

| State | Rendered width | Natural width of its content |
|---|---|---|
| Run | 76.4 px | 76.4 px |
| Stop | **119 px** | 80.3 px |
| Stopping… | 120.2 px | 120.2 px |

The view locks `min-width` to the widest label ("Stopping…") when the program starts. As a result, Run jumps from 76 px to 119 px. Todd: "The button shouldn't change sizes when it switches from Run to Stop. The interface should change as little as possible." He chose to keep Run's size, with a dimmed Stop during stopping (2026-10-11).

## Global Constraints

- The control's outer (border-box) width is the same in idle, running and stopping. It is whatever the control measured as Run just before it left idle; nothing in the toolbar moves.
- The visible content while running and while stopping is the same: icon `fa fa-stop`, label `Stop`. Stopping stays distinguishable by its existing dimmed color, its paused strip and `aria-disabled="true"`.
- The stopping wording stays for assistive tech and the tooltip: aria-label `Stopping program`, title/tooltip text `Stopping the program.`.
- Returning to idle restores each control exactly as it was, now including any inline `width`, `min-width`, `padding-left` and `padding-right` the markup had.
- Do not touch `glowscript.js`, `glowscript-run-state.js`, `glowscript-stop-shim.js`, the runner template, Pyodide, or `default-toolbar.html`. Change `_run_stop.scss` only if a rule there defeats the fixed width, and say why.
- No new dependency.

## Review Focus

1. **Stop is wider than Run** (the normal case, by about 4 px): the outer width stays put, and the content stays centered.
2. **An unrendered control** (zero width: a hidden toolbar, or jsdom without stubs): no width lock, and nothing else changes.
3. **A run that starts while stopping:** no re-measure, so no growth. The width was taken from Run when the control left idle.
4. **Markup with its own inline width or padding:** restored exactly on idle.
5. **Below the large breakpoint, where the label is hidden and only the icon shows:** the same rule holds (about 1 px icon difference).

---

### Task 1: Fixed-size Run/Stop control

**Files:**
- Modify: `public/js/embed/run-stop-button.js` (the `STATES` table, `snapshot()`, the width logic in `apply()`, the header comment; remove `widestWidth()`)
- Modify: `test/unit/run-stop-button.test.js`
- Modify: `test/browser/specs/glowscript-stop.spec.js`
- Modify: `docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md`
- Modify: `docs/superpowers/plans/2026-10-09-glowscript-stop-button.md` (one line in "Superseded during execution")

**Interfaces:**
- Consumes: `create(elements, $)`, which returns `{ set(state), state() }`. It is unchanged, and `glowscript.js` calls it as today.
- Produces: the same interface. Only rendering changes.

**Behaviour to implement in `apply(item, next)`:**
- **Leaving idle** (`current === 'idle'`, `next` running or stopping):
  1. Before changing anything, read `runWidth = el.getBoundingClientRect().width`, the control exactly as it shows Run.
  2. Swap the content to the running content: icon, label and the rest, as today.
  3. If `runWidth > 0`, read the natural width with the Stop content and no inline width or padding override: `stopWidth = el.getBoundingClientRect().width`.
  4. Then set `el.style.width = runWidth + 'px'`. Keep sub-pixel values; do not round.
  5. If `stopWidth > runWidth`, reduce `padding-left` and `padding-right` by `(stopWidth - runWidth) / 2` each, starting from the computed padding, clamped at 0, so the content stays centered and the outer width stays `runWidth`.
  6. Clear any `min-width` override the old code set.
  7. Check how `box-sizing` affects `style.width`. Foundation 5 sets `border-box` globally; if the control is `content-box`, compute the content width instead. State which applies in the report.
- **Running ↔ stopping:** no measurement and no width change; only class, aria and title change as today.
- **To idle:** restore the inline `width`, `min-width`, `padding-left` and `padding-right` values captured in `snapshot()`. Usually that is `''`.
- `STATES.stopping.label` becomes `'Stop'`. Its icon, aria and title stay as they are.
- `widestWidth()` and its comment are removed.

- [ ] **Step 1: Write the failing unit tests** in `test/unit/run-stop-button.test.js`. jsdom has no layout, so stub `getBoundingClientRect` per control. Its width should be the locked `style.width` when one is set, else a natural width that depends on the label text: for example Run 76.4 and Stop 80.4. Stub the computed padding through `window.getComputedStyle`, or through the control's inline padding.
  - Running and stopping both have `style.width === '76.4px'`, and padding reduced by 2 px each side. Back on idle, width, min-width and padding are restored to their originals.
  - When Stop fits (Stop natural ≤ Run), the width is locked and the padding is untouched.
  - An unrendered control (width 0) gets no inline width or padding.
  - Inline width or padding in the markup is restored exactly on idle.
  - A new run while stopping does not re-measure. Assert it with a spy, or by changing the stub between the two calls.
  - Update the existing stopping test: the label is `Stop`, aria-label `Stopping program`, and the tooltip and title `Stopping the program.`.
  - Replace the existing widest-label test (`keeps the control as wide as its widest label…`).
- [ ] **Step 2: Run them and watch them fail.** Use the repo's vitest on that one file. The session's scratchpad config, or `npx vitest run test/unit/run-stop-button.test.js` with a long hook timeout, avoids app boot.
- [ ] **Step 3: Implement** the behaviour above in `run-stop-button.js`. Update the header comment: Run and Stop, and Stop dimmed while stopping.
- [ ] **Step 4: Run the four Stop-button unit files** and see them pass.
- [ ] **Step 5: Add width checks to the Playwright spec.**
  - Add a test, "the control keeps its width through Run, Stop and Run again":
    1. Open `/embed/glowscript` and measure `.run-it`'s `boundingBox().width` while idle.
    2. Run the `LOOP` program and measure again while running.
    3. Poll until the program has printed.
    4. Wait past the double-click guard, click Stop, wait for Run, and measure once more.

    All three widths must match within 0.5 px.
  - In the existing output-only Enter test, also assert that `button.run-it` has the same width before Run, while running, and after the teardown.
  - Run `node --check` on the spec.
- [ ] **Step 6: Update the docs.**
  - **Spec, button states:** the stopping row shows `Stop`, dimmed with the strip paused. Its aria-label and tooltip stay "Stopping…".
  - **Spec, width rule:** replace "locked to the widest label" with "keeps the exact width it has as Run in every state; Stop takes the few pixels it needs from the inner padding".
  - **Spec, Known limits:** add that if the viewport crosses the large breakpoint while a program runs, the locked width holds until Run returns.
  - **Old plan:** in its "Superseded during execution" note, point Task 4's width lock at this plan.
- [ ] **Step 7: Commit.** Use one commit, or two (code+tests, docs), that say why. End each message with your accurate co-author trailer.
