# Stop button for Web VPython (GlowScript) trinkets

Status: design approved 2026-10-09 by Todd Zimmerman in a brainstorming session.
Amended 2026-10-12, after the review of #336: Todd approved the ↻ Run look the control takes after an edit (button states, wiring and edge cases below), and the shim now accepts a stop only from its parent and settles a continuation once.
Branch `stop-button`, cut from `main` at `486a659`. Line anchors below refer to that commit.
Implementation plan: `docs/superpowers/plans/2026-10-09-glowscript-stop-button.md`.

## Problem

A Web VPython trinket (the `glowscript` trinket type, not Python trinkets that
import vpython) has no way to stop a running program. Pressing Run rebuilds the
program's sandboxed iframe, so the only way to halt `while True: rate(100)` is to
run it again or leave the page. The page also never learns when a program
finishes, so it cannot show whether anything is still running.

Wanted behaviour, in the requester's words: once a user hits Run, the button
changes to a stop sign; when the code finishes it changes back to Run; hitting
Stop while code is running interrupts it and the button turns back to Run; while
code is actively running the Stop button shows a subtle animation.

## Decisions

| Question | Decision | Rejected |
|---|---|---|
| Which trinket types | GlowScript Web VPython only. Pyodide is left alone and may be revisited later to match this look. | Python only; Python plus GlowScript; all browser runtimes |
| What Stop leaves on screen | Freeze in place: the 3D scene, graphs, captions and printed output stay, and the camera can still be rotated and zoomed. | Clear the output; still image of the last frame |
| Running animation | One short strip laps the inside edge of the button, one lap every 1.6 s. | Orbiting ring around the icon (disliked); twin strips; long slow strip; breathing tint; sliding bottom strip; pulsing icon |
| Implementation | A: a pause shim injected into the runner page, with a guaranteed teardown fallback. | B: a stop API inside rsWVPRunner (needs a runtime rebuild, covers 3.2.3 only); C: teardown only (contradicts freeze in place) |
| Stop icon | Font Awesome `fa-stop` (square), as trinket's existing Stop controls use. An octagon was previewed and is not chosen. | Octagon |
| Running again after an edit (added in the review of #336) | One click: while the editor holds something other than what runs, the control reads ↻ Run and a click runs the changes; undoing back to the running text shows Stop again. | Stop, then Run, as before (two clicks) |

## What exists today

- The editor toolbar's Run control is `<a class="run-it menu-button item allow-original" data-action="code.run" data-tooltip ...>` with `fa-play` and a `Run` label (`lib/views/embed/glowscript.html:19`). Output-only embeds use the shared `lib/views/embed/default-toolbar.html:1`, whose `.run-it` is a `<button>`; that file also holds a hidden `.stop-it` that only the Pyodide runner reveals.
- `public/js/embed/embed.js:270` turns a click or Enter on any `.menu-button` into the jQuery event `trinket.<data-action>`. Ctrl/Cmd-Enter in the editor fires `trinket.code.run` directly (`glowscript.js:363`).
- `trinket.code.run` calls `showResult()` and then `runCode()` (`glowscript.js:379`, `:148`). `runCode()` fills the client-side template `#glowscriptTemplate` (`glowscript.html:154`) and loads it into a fresh `sandbox="allow-scripts ..."` srcdoc iframe `#glowscriptOutput` (`runCodeLocal`, `glowscript.js:112`) or posts it to an external sandbox server first (`runCodeExternal`, `:131`).
- The runner page loads the GlowScript runtime (`glow`, `RSrun`, `RScompiler` for the requested version) in `<head>`, then compiles the program and runs it. For 2.9 and later it runs `eval(program); await __main__()` inside `runProgram()` (`glowscript.html:238-241`). For 1.1 to 2.7 it calls `window.userMain(callback)` (`:290`).
- The runner talks to the page only by `postMessage` with JSON strings: `glowscript.loadfail` (a runtime file failed; the page rebuilds with backoff, `glowscript.js:85-108`), `glowscript.error` (compile or runtime error; the page shows an alert banner, `:468-483`), and `snapshot` (thumbnail capture). The page sends the plain string `glowscript.snapshot`. There is no finished message and no notion of a running program.

## Design

### Units

1. **Runner shim**, `public/js/embed/glowscript-stop-shim.js`. A single self-contained function `install(win)` that references nothing outside itself, exported UMD-lite like `runner-retry.js`. `glowscript.js` injects its source text into the runner template through a new `{{stopShim}}` placeholder placed at the top of the runner's body script, after the runtime has loaded and before the program is compiled. It:
   - posts `glowscript.ready`;
   - wraps the wait functions `win.rate`, `win.sleep`, `win.waitfor`, `win.pause`, and `win.canvas.prototype.waitfor` and `.pause`, each only if it exists and is a function, and only once;
   - listens for the `glowscript.stop` message, and accepts it only from its parent, the embed page, which is the runner's direct parent in both sandbox modes; a stop from any other window is ignored;
   - while no stop is requested, every wrapper is a pass-through;
   - after a stop request, a wait that is in progress never hands control back to the program, a new call never starts (except while a snapshot of the stopped program is being taken; see Edge cases), and the runner posts `glowscript.stopped` once.

   Both GlowScript calling styles are handled: a promise result (2.9 and later) and a continuation callback as the last argument (1.1 to 2.7). A wrapped continuation settles its wait only once, however often the runtime calls it, so a repeated call neither resumes the program again nor hides a wait that is still pending from a stop. If a stop arrives while at least one wrapped wait is pending, the confirmation is immediate; otherwise it is sent when the program next calls a wrapped function.
2. **Runner template change** in `glowscript.html`. Insert `{{stopShim}}`, and post `glowscript.done` when the program finishes normally: after `await __main__()` returns, and in the `userMain` callback when there is no error. Error paths are unchanged, except that on 2.9 and later `window.onerror` tags an error raised while the main flow runs (see the message protocol).
3. **Run-state controller**, `public/js/embed/glowscript-run-state.js`. Pure, UMD-lite, no DOM and no clock of its own: the page passes in timer functions and callbacks (`onState`, `requestStop`, `teardown`). It owns the states, the 2 s stop window, and a generation number.
4. **Run/Stop button view**, `public/js/embed/run-stop-button.js`. Given the `.run-it` elements on the page, it records each one's original action, title, aria-label, icon class, label text and inline width, min-width, padding and white-space, and applies the three visual states, plus the ↻ Run look a running control takes while the editor holds something else (`edited(flag)`; see Button states). Returning to idle restores the recorded originals exactly, so both toolbars keep their own wording and size. Styles live in a new `static/scss/embed/_run_stop.scss`, imported by `embed.scss`; every rule is scoped to state classes that only this view adds, so other runtimes are unaffected.

`glowscript.js` wires them together and owns the DOM: it builds the controller and the view, injects the shim source, routes messages, handles `trinket.code.stop`, drives the ↻ Run look from `trinket.code.change`, and guards asynchronous rebuilds with the generation number.

### Message protocol

| Direction | Message | Meaning |
|---|---|---|
| runner to page | `{"glowscript.ready": true}` | The runner's body script has started; the program is about to compile and run. A runner that already reported a load failure is ignored, so its ready never counts |
| runner to page | `{"glowscript.done": true}` | Program finished normally (new) |
| runner to page | `{"glowscript.stopped": true}` | Program parked after a stop request (new) |
| runner to page | `{"glowscript.error": ..., "type": ...}` | Existing; treated as the end of the run, unless it carries `glowscript.background` |
| runner to page | `{"glowscript.error": ..., "type": "runtime", "glowscript.background": true}` | An error `window.onerror` caught while the program's main flow runs, on 2.9 and later: raised outside that flow (an event handler, a timer), so it does not end the run (new field) |
| runner to page | `{"glowscript.loadfail": src}` | Existing; drives the rebuild policy |
| page to runner | `"glowscript.stop"` | Park the program now (new; same plain-string style as `glowscript.snapshot`). The shim ignores it from any window but its parent |

The page passes runner messages to the controller only when `event.source` is the current `#glowscriptOutput` window, so a late message from an earlier run cannot change the button. The existing error banner keeps its current behaviour.

### Run-state controller

States are `idle`, `running` and `stopping`. The generation number increases on every launch and every teardown.

| From | Event | To | Effect |
|---|---|---|---|
| any | `launched` (a new run began) | running | New generation; cancel any stop timer; runner not yet ready. The control starts not edited |
| running | `ready` | running | Runner marked ready |
| running or stopping | `done`, or an `error` without `glowscript.background` | idle | Cancel stop timer |
| running or stopping | `error` tagged `glowscript.background` | unchanged | Ignored: the program's main flow is still running |
| running or stopping | `loadFailed` (retry budget exhausted) | idle | Cancel stop timer |
| running, within 500 ms of `launched` | `stop` | running | Ignored: the second click of a double-click on Run (added during planning) |
| running, runner ready | `stop` | stopping | `requestStop()`; start the 2000 ms stop timer |
| running, runner not ready | `stop` | idle | `teardown()`; new generation |
| stopping | `stopped` | idle | Cancel stop timer; scene stays frozen |
| stopping | stop timer fires | idle | `teardown()`; new generation |
| stopping or idle | `stop` | unchanged | Ignored |
| idle | `ready`, `done`, `stopped`, `error` | idle | Ignored by the controller (the error banner still shows) |
| running | an edit: the editor's program now differs from what launched | running | Not a controller event: the page draws ↻ Run (see Button states) |
| running, ↻ Run showing | an undo: the editor's program equals what launched again | running | Not a controller event: the page draws Stop again |
| running, ↻ Run showing | `launched` (the ↻ Run click, or Ctrl/Cmd-Enter) | running | As for any `launched`. The state does not change, so the controller draws nothing and `runCode()` draws the control as Stop |
| stopping or idle | an edit | unchanged | Ignored: stopping stays Stopping, with no ↻ Run, and idle stays plain Run |

`teardown()` empties `#glowscriptIframeContainer`, hides `#loadingContent`, and shows a one-line note in the output area: "Program stopped. Press Run to start it again."

### Button states and visuals

| State | Icon | Label | `data-action` | aria-label | Look |
|---|---|---|---|---|---|
| idle | original (`fa-play`) | original (`Run`) | original (`code.run`) | original | Unchanged from today |
| running | `fa-stop` | `Stop` | `code.stop` | `Stop program` | Icon and label red `#C62828` (5.6:1 on white); one strip laps the inside edge |
| running, code edited | `fa-repeat` | `Run` | `code.run` | `Run your changes` | The normal Run look in place of Stop's red: icon and label gray `#525252`, nothing filled, and a blue `#008AFF` fill with white content on hover; one strip still laps the inside edge, in gray `#6B6B6B`; no `aria-disabled` |
| stopping | `fa-stop` | `Stop` | `code.stop` | `Stopping program` | The running control, dimmed: icon and label gray `#6B6B6B`; strip paused at half opacity; no hover fill; `aria-disabled="true"` |

- **Edited** means that the editor's serialized program (`api.getValue()`, which covers every file) differs from the serialized text the current run launched with. It is evaluated on every `trinket.code.change`, and after a reset, while the controller is running, so undoing or resetting back to the exact running text shows Stop again. It applies only while the controller is running: stopping and idle look as in the rows above, every change of state clears it, and a new run starts not edited. A click on ↻ Run goes the way a click on Run goes (`code.run`, the same path Ctrl/Cmd-Enter takes), so it runs the changes, and the 500 ms double-click guard applies to the new run as to any other.
- The ↻ Run control is the running control with a second class, `run-state-edited`, so the strip, its lap, the focus ring and the reduced-motion outline carry over, and the normal Run colors replace the red. Hover and keyboard focus fill it with the toolbar's blue and turn its icon, label and strip white; focus keeps the visible 2px ring.
- The strip is an `aria-hidden` SVG injected once into the control: inset 3px from each edge, a `rect` with `width="100%" height="100%" rx="3" pathLength="100"`, stroke 2px in `currentColor`, `stroke-dasharray: 24 76`, animated by `stroke-dashoffset` from 0 to -100 over 1.6 s, linear, infinite.
- Hover and keyboard focus while running fill the control with `#C62828` and turn the icon, label and strip white; focus also shows a visible 2px ring.
- `prefers-reduced-motion: reduce` replaces the moving strip with a static 1.5px outline in the same color: gray on ↻ Run.
- The control keeps the exact width it has as Run in every state, so nothing in the toolbar moves. The view measures that width, to the sub-pixel, as the control leaves idle. Stop comes out a few pixels wider than Run (about 4 px with the label showing, about 1 px with only the icon) and takes the few pixels it needs from the control's inner padding, half from each side, so the content stays centered. The content is held to one line, so a rounding step in the browser's layout cannot wrap the label under the icon. Running and stopping share the width, so only leaving idle measures; a control that is not rendered (a hidden toolbar) is left alone. Returning to idle restores any inline width, min-width, padding and white-space the control's markup had. ↻ Run holds the same width: its content is not Stop's (the label Run is shorter than Stop; the repeat icon is as wide as the stop icon), so the side padding is fitted to the content that shows, half from each side again, and the content stays centered. The content is measured from its own boxes, the icon and the label and the gap between them, so the held width is never released to measure; Stop's fit comes back as the very values the view first wrote, not as the style reads them back, when the edit is undone.
- The visible label reads Stop while stopping, so the aria-label ("Stopping program") and the tooltip are what say that it is stopping. The title follows the state: "Stop the program." while running, "Run your changes (restarts the program)." while running with edited code, and "Stopping the program." while stopping. The editor toolbar's control has a Foundation tooltip, which this project's Foundation 5.5 builds once at page init from the title, blanking the title as it does, and never rebuilds; for such a control the view rewrites the tooltip's text in place and leaves the title as Foundation left it. A control without a tooltip carries the wording in its title attribute.
- Clicks in stopping are ignored by the controller.

### Wiring in glowscript.js

- `runCode()` calls `launched()` right before it hands the runner HTML to `runCodeLocal` or `runCodeExternal`, after every early return, such as an invalid version, has passed.
- `runCodeExternal` records the generation before its POST and inserts the iframe only if the generation is unchanged when the reply arrives.
- A load-failure rebuild records the generation when it is scheduled and is skipped if the generation has changed. When a retry is scheduled, later messages from that failing runner, such as its follow-on compile error, are not passed to the controller. When the policy reports the budget exhausted, the page calls `loadFailed()`.
- `trinket.code.stop` calls `stop()`. `requestStop()` posts `glowscript.stop` to the current runner window.
- `runCode()` keeps the serialized program it launches with (`api.getValue()`, the same text it records as run) in `launchedCode`, set before it calls `launched()`.
- `trinket.code.change`, which `api.triggerChange()` fires on `document` for every change in the editor, undo and redo included, re-evaluates the control: while the controller is `running`, the page calls `edited(api.getValue() !== launchedCode)` on the view. The call is wrapped in a try/catch that only warns, like the one around `set()`, so drawing the control never keeps an edit or a Run from happening. The view ignores `edited()` in any other state, and when the control already shows what it is asked for.
- `reset()` ends with the same re-evaluation. It replaces the editor's text without firing `trinket.code.change`, and it leaves a running program alone, so the Reset button, a restored session and the remix version toggle, which all come through it, would otherwise leave the control showing Stop for text that no longer matches, or ↻ Run for text that matches again. It changes nothing where nothing runs, such as at startup, and where `start=result` has just launched the new text.
- `launched()` while the controller is already `running` changes no state, so it makes no `onState` call and the view is not redrawn. `runCode()` therefore re-evaluates the control right after `launched()`, against the `launchedCode` it just set, which is how every run, the ↻ Run click and Ctrl/Cmd-Enter included, starts as Stop.
- The ↻ Run click needs no code of its own: the view sets `data-action` to `code.run` on the attribute and on jQuery's cached `.data('action')`, and `embed.js` sends the click through `trinket.code.run` and `showResult()` to `runCode()`.

## Edge cases

- A double-click on Run: the second click lands on the new Stop within 500 ms of the launch and is ignored, so the program keeps running.
- Stop while the runtime is still loading, before `glowscript.ready`: immediate teardown.
- A program that finishes on its own, including a static scene with no loop: back to Run when `glowscript.done` arrives; the scene stays interactive exactly as today.
- Compile or runtime error: the existing alert banner, and back to Run.
- An error raised outside the main flow while the program runs (an event handler, a widget callback, a timer), on 2.9 and later: `window.onerror` tags its report `glowscript.background`. The existing alert banner still shows it, and the control stays Stop, because the main flow is still running.
- Enter on the output-only toolbar's `<button>` Run/Stop control: `embed.js` acts on the keypress, so `glowscript.js` cancels the click the browser would synthesize from it, and each Enter is dispatched once. Otherwise Enter on Stop before the runner is ready would tear the run down, and the synthesized click, by then on Run, would restart it.
- Ctrl/Cmd-Enter while running or stopping, and a click on ↻ Run: a fresh run replaces the old one, as today, and the button is Stop for the new run, whether or not it read ↻ Run before. The "Run your code first" modal's Run is not a way to re-run: its handler throws (a bare `sendInterfaceAnalytics`, which is not defined) before it reaches `runCode()`, so it starts no run, whatever the state. That predates this work and is out of scope here; it is tracked in #338.
- An edit while the control is stopping: nothing changes. It stays Stopping, with no ↻ Run, since the program is already being ended; after the stop it is plain Run.
- A second click right after ↻ Run: the control is Stop as soon as the first click has run, so the second lands on Stop within 500 ms of the launch and is ignored, as for a double-click on Run.
- An edit in a file that is not showing counts, and so does undoing it: the comparison is of every file.
- External sandbox mode, load-failure retries and thumbnail snapshots all respect the generation guard. A frozen runner still answers `glowscript.snapshot`; after a teardown the existing snapshot code already skips a missing iframe. The runtime's screenshot goes through the waits the shim parks, so the runner template asks the shim for a window in which new waits pass through and the screenshot can finish: the window is granted only after a confirmed stop, each wait is decided when it is made, and the window closes when the screenshot settles, or after 5 s at most.
- Output-only embeds (`default-toolbar.html`) and calculator run mode behave the same as the editor view.

## Known limits

- Event handlers the program registered, such as `scene.bind` or widget `bind=` callbacks, still respond after Stop. The main program flow is halted; handlers are not.
- After an edit the control restarts the program rather than stops it. To stop without restarting, undo the edit, or stop the new run.
- An edit that makes the program's first line an unknown version, such as `Web VPython 9.9`, leaves ↻ Run with nothing to run: `runCode()` shows the "Invalid version of GlowScript." alert and returns before it launches anything. The old program keeps running and the control stays ↻ Run, so the program cannot be stopped from the control meanwhile. It stays that way until the line is fixed and ↻ Run is clicked, which restarts with the fix, or the edit is undone.
- Edited is a comparison of the whole serialized program, so adding or removing an inline comment counts as an edit too.
- A program parked in an await the shim does not wrap, or computing for more than 2 s without calling a wrapped function, gets the teardown and the note instead of a freeze.
- A loop with no `rate()` or `sleep()` can freeze the browser tab before Stop can be clicked, as with Python on the main thread. No button can fix that.
- Only the 3.2.3 runtime is checked in a browser during this work. The other versions rely on unit tests of both calling styles and on the teardown fallback.
- Before GlowScript 2.9, any error report ends the run, including one from an event handler: there, the main flow's own errors may surface only through `window.onerror`, so the runner cannot tell the two apart.
- If the viewport crosses the large breakpoint while a program runs, which shows or hides the editor toolbar's Run label, the locked width holds until Run returns: the control is then wider than its content, or its content overflows it, for the rest of that run. The next run measures again.
- A snapshot started before a stop is confirmed may not complete: one requested while the control is in its dimmed stopping state, or one still under way when Stop is pressed, parks with the program, so that save keeps no new thumbnail.
- The snapshot window exempts every wait that starts while it is open, not only the screenshot's. An event handler's flow can therefore advance while a snapshot of a stopped program is taken, for at most 5 s. In a rare case the main flow can too: when it was in an await the shim does not wrap at the moment another flow's wait confirmed the stop. It parks again at its first wait after the window closes.

## Out of scope

- The Pyodide runner, its separate `.stop-it` control, and the markup of the shared `default-toolbar.html`.
- Web VPython Blocks (`glowscript-blocks`), the Skulpt and Pygame runners, and server-side languages.
- Silencing handlers bound by the program after Stop.

## Testing and verification

1. **Spike (throwaway, kept out of the repository).** A browser harness built like the runner template loads the real 3.2.3 runtime from the `rswvprunner` GCS bucket, plus jQuery and jQuery UI, and runs the shim. It must show that:
   - the wrappers for `rate()` and `sleep()` are the functions the compiled program calls;
   - after a stop request the program makes no further progress and `glowscript.stopped` is posted;
   - the parked scene still redraws when the camera is rotated;
   - a finite program posts `glowscript.done`.

   If interception fails, work stops and the approach is revisited with the requester before anything else is built.
2. Unit tests (Vitest), named after their units:
   - `glowscript-stop-shim.test.js` covers both calling styles, pass-through, stop while parked, stop while computing, the single confirmation, idempotent install, the pending bookkeeping, a continuation the runtime calls twice settling its wait once, a stop accepted only from the parent window, and the snapshot window: granted only after a confirmed stop, decided per wait, idempotent release and the 5 s auto-release.
   - `glowscript-run-state.test.js` covers every row of the transition table, including background errors and non-object messages, and the order of drawn states on the stop paths.
   - `run-stop-button.test.js` (jsdom) covers each state's action, label, icon, aria, title, tooltip text rewrite and strip injection; the width hold (Run's width kept through Stop and Stopping, sub-pixel, the difference taken from the padding and clamped, no new measurement while stopping, an unrendered control left alone, a content-box control); and the exact restore of both toolbars' originals, inline size included. For the ↻ Run look (`edited()`) it covers every wording, the cached action, the tooltip rewrite and the exact return to Stop; that `set()` clears it for each state, and that it does nothing in idle or stopping or when the control already shows what it is asked for; and its width fit: the held width kept, the side padding fitted to ↻ Run's content measured from the icon and label boxes without releasing the width, uneven padding and a content-box control handled, an unrendered control left alone, and Stop's fit restored as the values first written, not as the style reads them back. jsdom has no layout, so the tests state what a browser would measure.
   - `glowscript-runner-template.test.js` loads the template from `glowscript.html`, fills it the way `glowscript.js` does, and runs it against a fake runtime. It checks that the shim installs before the program runs, that ready then done is posted on both version paths, that a failing shim never keeps the program from running, that a stopped program still answers a snapshot request, and that `window.onerror` tags background errors only while the 2.9+ main flow runs. Its stop is delivered as the page's is, from the runner window's parent.
3. `npm run build:css` succeeds with the new partial.
4. `test/browser/specs/glowscript-stop.spec.js` (Playwright, local stack) covers:
   - Run shows Stop with the strip;
   - the control keeps its width and height through Run, Stop and Run again, with the label showing and, below the large breakpoint, with only the icon;
   - Stop returns to Run and the program is frozen in place, parked rather than torn down;
   - a loop that calls `vp.rate()` through `import vpython as vp` stops in place too;
   - a stopped program still answers a snapshot request;
   - an error in an event handler does not end a running program;
   - a finite program returns to Run on its own;
   - a compile error returns to Run;
   - Enter on the output-only Stop button stops the program instead of restarting it, and that control keeps its size through the Run and the teardown;
   - editing a running program turns Stop into ↻ Run at the same size, one click on it runs the changes, and the control is Stop for the new run, whose output replaces the old one's;
   - undoing the edit back to the exact running text, by setting the text and by keystrokes and the editor's undo, shows Stop again;
   - an edit, and its undo, in a file that is not showing;
   - an edit while the program is stopping shows no ↻ Run, and the stop ends in plain Run;
   - a second click right after ↻ Run is the double-click guard's: the control is Stop already, and the new run goes on;
   - Ctrl/Cmd-Enter after an edit runs the changes and the control is Stop for the new run;
   - a Reset, through the menu and its confirmation on a saved trinket, back to the text that runs shows Stop (and the program goes on), and a Reset away from the text that runs shows ↻ Run, whose click runs the saved text; the editor's `reset()` called on its own, as a restored session or the remix toggle calls it, does the same in both directions;
   - the control keeps its width and height, and its content stays centered, through Run, Stop, ↻ Run, Stop again and Run again, with the label showing and with only the icon, and Stop comes back at the very width it had;
   - the ↻ Run look in the browser's own cascade: the toolbar's gray at rest, blue with white content on hover, the strip lapping in gray, and a still gray outline under reduced motion.

   It needs the local stack and the vendored runtime. If that is not available during the work, it is committed unrun and marked as such.
5. The full unit suite passes.

## Order of work

Spike; shim; controller; button view and SCSS; wiring and template; Playwright spec; a changelog entry. What's New is left alone: its rework is tracked in #332. Planning and tracking use CCPM (PRD, epic and tasks under `.claude/`, which git ignores) and the Superpowers implementation plan named above.
