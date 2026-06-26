# Pyodide Variable Explorer — MVP scope

Branch: `feature/pyodide-variable-explorer`

A read-only "Variables" panel that, after each run of a Pyodide ("Python")
trinket, lists the top-level names the program defined — name, type, and a
truncated `repr` — so students can see their program's state without adding
`print()` calls. Scoped to the Pyodide runner only.

## Why this is a good fit

The Pyodide runner (`public/js/embed/pyodide.js`) executes **real CPython in
WASM**, so the module namespace is a first-class, introspectable object:
`pyodide.globals` is a live `PyProxy` of the user program's globals. We get
accurate `type(x).__name__`, `repr(x)`, and `len(x)` for free — no fragile
JS-side reconstruction (which the Skulpt path would have required).

## Integration points (already in the code)

| Concern | Hook | Location |
|---|---|---|
| When to snapshot | `finishRun(serializedCode, err)` — runs on success **and** error | `pyodide.js` ~L346 |
| Namespace source | `pyodide.globals` (PyProxy dict) | available once `pyodideReady` |
| Where the tab goes | `#outputTabs` (has `#codeOutputTab`, `#instructionsTab`) | `embed/pyodide.html` ~L120 |
| Content panes | `#outputContainer`, `#instructionsContainer` inside `#codeOutput` | `embed/pyodide.html` L106–141 |
| Tab show/hide today | `showResult()` / `showInstructions()` toggle `.active` + container visibility | `pyodide.js` ~L702 |

The two existing tabs dispatch through the shared embed framework
(`data-action="output.view"` / `"instructions.view"` → `api.showOutput` /
`api.showInstructions` in `embed.js`). To keep blast radius small, the
**Variables tab is wired locally in `pyodide.js`** with a direct click handler
rather than adding a new action to the shared framework. `showResult()` and
`showInstructions()` live in this file's `TrinketAPI`, so we extend them to also
hide the variables panel and clear its active state — no cross-trinket changes.

## Names the runner injects (must be filtered out)

The runner puts non-user names into globals; the explorer must hide them:
`__user_source__`, `_plt`, `_vpy`, `_js_scene`, `_wrapped_rate`, plus all
dunders and imported modules.

## Data extraction — clean, zero-pollution approach

Introspect in a **dedicated Pyodide namespace** that reads the user globals by
reference, so nothing (`json`, `types`, helper fn) is injected into the user's
own namespace:

```js
// VARS_HELPER iterates user_ns rather than globals(), so it touches nothing in
// the user's namespace.
var VARS_HELPER = [
  "import json, types",
  "_SKIP = {'__user_source__','_plt','_vpy','_js_scene','_wrapped_rate'}",
  "_out = []",
  "for _name, _val in list(user_ns.items()):",
  "    if _name in _SKIP: continue",
  "    if _name.startswith('__') and _name.endswith('__'): continue",
  "    if isinstance(_val, types.ModuleType): continue",
  "    _kind = 'value'",
  "    if isinstance(_val, (types.FunctionType, types.BuiltinFunctionType, types.LambdaType)): _kind = 'function'",
  "    elif isinstance(_val, type): _kind = 'class'",
  "    try: _r = repr(_val)",
  "    except Exception as _e: _r = '<unrepresentable: %r>' % (_e,)",
  "    if len(_r) > 300: _r = _r[:300] + '\\u2026'",
  "    try: _n = len(_val)",
  "    except Exception: _n = None",
  "    _out.append({'name': _name, 'type': type(_val).__name__, 'kind': _kind, 'repr': _r, 'len': _n})",
  "_out.sort(key=lambda d: (d['kind'] != 'value', d['name']))",
  "json.dumps(_out)"
].join("\n");

function snapshotVariables() {
  if (!pyodide || !pyodideReady) return [];
  var ns = null, json;
  try {
    ns = pyodide.toPy({ user_ns: pyodide.globals });  // user_ns is a live ref
    json = pyodide.runPython(VARS_HELPER, { globals: ns });
    return JSON.parse(json);
  } catch (e) {
    return [];
  } finally {
    if (ns && ns.destroy) { try { ns.destroy(); } catch (e) {} }
  }
}
```

Returning a `json.dumps` **string** (not a PyProxy) means a single
`JSON.parse` on the JS side — robust against numpy/pandas/objects, and no proxy
lifetime management for the result.

## UI

- **Tab:** add `<div id="variablesTab" class="menu-button">Variables <span id="variablesCount"></span></div>` to `#outputTabs`.
- **Panel:** add `<div id="variables-wrap" class="hide">` as a sibling of `#outputContainer` inside `#codeOutput`; it holds a `<table id="variables-table">` (columns: Name / Type / Value).
- **Behavior:**
  - `finishRun` → `renderVariables(snapshotVariables())`; update `#variablesCount` badge.
  - Click `#variablesTab` → `showVariables()`: hide `#outputContainer` + `#instructionsContainer`, show `#variables-wrap`, move `.active`.
  - Extend `showResult()` / `showInstructions()` to hide `#variables-wrap` and deactivate `#variablesTab`.
  - Empty state: "No variables yet — run your code." `function`/`class` rows visually de-emphasized (or behind a "show functions" toggle in Phase 2).
- **CSS:** one scoped block (reuse the console/instructions panel sizing under `#embed_content_python`).

## Files touched

| File | Change |
|---|---|
| `public/js/embed/pyodide.js` | `VARS_HELPER`, `snapshotVariables()`, `renderVariables()`, `showVariables()`; call from `finishRun`; extend `showResult`/`showInstructions`; bind tab click in `initialize` |
| `lib/views/embed/pyodide.html` | `#variablesTab` in `#outputTabs`; `#variables-wrap` panel; small scoped `<style>` |

No server, route, model, or shared-framework changes. No new dependencies
(Pyodide already loaded).

## Phasing

- **Phase 1 (core, ~1–1.5 d):** helper + snapshot + tab/panel + flat table (name/type/repr) + count badge + empty state. Functions/classes filtered out (values only).
- **Phase 2 (polish, ~0.5–1 d):** show/hide functions & classes toggle; per-type icons/coloring; smarter truncation (collection length shown, e.g. `list (1000 items)`); copy-value; a11y (the panel is `aria-live`, keyboard-focusable).
- **Phase 3 (deferred):** expandable nested inspection of lists/dicts/objects (lazy, with recursion + size guards). Not in MVP.

## Known limitations (acceptable for MVP)

- **Module-level globals only** — locals inside functions are gone after return (same as Jupyter's namespace view).
- **Post-run snapshot, not live/stepping** — no pause-mid-execution. Out of scope (would need a settrace stepper; weeks of work).
- **VPython runs:** snapshot still works (globals populated), but a running
  animation's loop variables reflect the last completed state.
- **Large objects:** `repr` truncated to 300 chars server-side (in Python) to
  avoid giant strings; collection element counts surfaced in Phase 2.

## Open questions for product

1. Show functions/classes at all, or values only? (MVP: values only, toggle in P2.)
2. Should the Variables tab auto-focus after a run, or stay on Result? (MVP: stay on Result; just update the count badge so it's discoverable.)
3. Include in the `outputOnly` embed layout, or editor view only? (MVP: editor view only — `outputOnly` has no tab bar.)
