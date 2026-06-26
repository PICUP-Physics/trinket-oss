"""
Async source transformer for the WASM (Pyodide) runner.

Web VPython programs call ``rate()`` (and ``sleep()``, ``scene.waitfor()`` /
``get_library()``) as if they were ordinary blocking functions. In the browser
these are actually asynchronous, so the runner executes the whole program with
Pyodide's ``runPythonAsync``, which permits top-level ``await``. The old runner
used regex substitution to insert ``await`` before each ``rate(`` — but that
produces ``await`` inside a plain ``def``, which is a SyntaxError
(GitHub issue #1).

This module uses the AST to *decide* what to change, then applies minimal
textual insertions (``async `` / ``await ``) at the exact source positions:

  * Calls to the known-async primitives (``rate``, ``sleep``,
    ``get_library``, ``*.waitfor``) get ``await`` inserted before them.
  * Any function whose body then contains an ``await`` is promoted to
    ``async def``.
  * Calls to a now-async user function get ``await`` inserted too, which can
    promote their callers in turn. This propagates to a fixpoint so
    arbitrarily deep call chains work.

Insertions never add or remove lines, so line numbers, comments, and blank
lines are preserved exactly — error tracebacks still point at the user's
original lines. (An ``ast.unparse`` round-trip would discard all of that.)

The transform is pure standard-library (only ``ast``) so it can be unit-tested
outside Pyodide. It must not import anything from the rest of the ``vpython``
package (whose ``__init__`` pulls in ``js``).

Known limitations (documented, matching the previous behavior):
  * ``rate()`` inside a ``lambda`` or a comprehension cannot be fixed (those
    cannot be async). Such calls are left untouched.
  * A user function passed by reference as an event callback
    (``scene.bind('mousedown', f)``) is promoted to ``async`` if it contains
    ``rate()``, but the binding site is not awaited. Event handlers that loop
    with ``rate()`` remain an unsupported edge case.
"""

import ast

# Bare-name calls that are awaitable primitives.
_BASE_AWAIT_NAMES = frozenset({'rate', 'sleep', 'get_library'})
# Attribute calls (obj.<attr>(...)) that are awaitable primitives.
_BASE_AWAIT_ATTRS = frozenset({'waitfor'})


def _scope_descendants(node):
    """Yield descendants of ``node`` within the same function scope.

    Does not cross into nested ``def`` / ``async def`` / ``lambda`` bodies,
    because calls there belong to *those* scopes, not this one.
    """
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        yield child
        yield from _scope_descendants(child)


def _scope_calls(func_node):
    """All Call nodes in a function's own scope (excluding nested functions)."""
    for stmt in func_node.body:
        if isinstance(stmt, ast.Call):
            yield stmt
        for n in _scope_descendants(stmt):
            if isinstance(n, ast.Call):
                yield n


def _is_trigger_call(call, async_names, async_methods):
    """True if this Call should be awaited given what we know is async so far."""
    func = call.func
    if isinstance(func, ast.Name):
        return func.id in _BASE_AWAIT_NAMES or func.id in async_names
    if isinstance(func, ast.Attribute):
        return func.attr in _BASE_AWAIT_ATTRS or func.attr in async_methods
    return False


def _collect_functions(tree):
    """Return list of (node, is_method) for every def/async def in the tree."""
    funcs = []

    def walk(node, in_class):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                funcs.append((child, in_class))
                walk(child, in_class=False)  # bodies of methods are not classes
            elif isinstance(child, ast.ClassDef):
                walk(child, in_class=True)
            else:
                walk(child, in_class)

    walk(tree, in_class=False)
    return funcs


def _compute_async(tree):
    """Find which functions must be async. Returns (ids, names, methods)."""
    funcs = _collect_functions(tree)

    async_ids = set()
    async_names = set()
    async_methods = set()

    # Seed: user-written async defs make their callers await them too.
    for node, is_method in funcs:
        if isinstance(node, ast.AsyncFunctionDef):
            async_ids.add(id(node))
            (async_methods if is_method else async_names).add(node.name)

    changed = True
    while changed:
        changed = False
        for node, is_method in funcs:
            if id(node) in async_ids:
                continue
            if any(_is_trigger_call(c, async_names, async_methods)
                   for c in _scope_calls(node)):
                async_ids.add(id(node))
                (async_methods if is_method else async_names).add(node.name)
                changed = True

    return async_ids, async_names, async_methods


def _calls_inside_lambdas(tree):
    """Ids of Call nodes anywhere inside a lambda body (can't be awaited)."""
    ids = set()
    for lam in ast.walk(tree):
        if isinstance(lam, ast.Lambda):
            for n in ast.walk(lam):
                if isinstance(n, ast.Call):
                    ids.add(id(n))
    return ids


def _apply_insertions(src, insertions):
    """Apply (lineno, col_offset, text) insertions to ``src``.

    ``col_offset`` is a UTF-8 byte offset (as ast reports it), so we edit each
    line in its byte form. Insertions on the same line are applied right-to-left
    so earlier offsets remain valid.
    """
    if not insertions:
        return src

    lines = src.splitlines(keepends=True)
    by_line = {}
    for lineno, col, text in insertions:
        by_line.setdefault(lineno, []).append((col, text))

    for lineno, edits in by_line.items():
        idx = lineno - 1
        if idx < 0 or idx >= len(lines):
            continue
        raw = lines[idx].encode('utf-8')
        for col, text in sorted(edits, key=lambda e: e[0], reverse=True):
            raw = raw[:col] + text.encode('utf-8') + raw[col:]
        lines[idx] = raw.decode('utf-8')

    return ''.join(lines)


def transform_source(src):
    """Rewrite ``src`` so blocking-looking async primitives work everywhere.

    Returns transformed source with line numbers and comments preserved. If
    ``src`` does not parse, it is returned unchanged so the normal execution
    path surfaces the SyntaxError.
    """
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return src

    async_ids, async_names, async_methods = _compute_async(tree)

    awaited_calls = {
        id(n.value)
        for n in ast.walk(tree)
        if isinstance(n, ast.Await) and isinstance(n.value, ast.Call)
    }
    lambda_calls = _calls_inside_lambdas(tree)

    insertions = []

    # Promote functions to `async def` by inserting `async ` before `def`.
    # (Already-async user defs are in async_ids but are AsyncFunctionDef, so
    # they're skipped here — no double `async`.)
    for node, _is_method in _collect_functions(tree):
        if isinstance(node, ast.FunctionDef) and id(node) in async_ids:
            insertions.append((node.lineno, node.col_offset, 'async '))

    # Insert `await ` before each triggering call.
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call)
                and id(node) not in awaited_calls
                and id(node) not in lambda_calls
                and _is_trigger_call(node, async_names, async_methods)):
            insertions.append((node.lineno, node.col_offset, 'await '))

    return _apply_insertions(src, insertions)
