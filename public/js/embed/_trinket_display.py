"""Typeset display hook for the trinket Pyodide runner.

A student writing SymPy in a Python trinket wants what a notebook gives: a bare
expression statement rendered as typeset mathematics, in order with the
program's other output. This module provides the Python half of that. The
JavaScript half (``pyodide.js``) renders the payloads this module emits.

How it works
------------
``wrap_module()`` rewrites every *module-level* expression statement
``<expr>`` into ``__trinket_display_hook__(<expr>, <lineno>)``. The hook
classifies the value, hands a payload to a sink if it can typeset itself, and
**returns its argument** — so the program's value semantics are untouched and
Pyodide's last-expression return keeps working (which is what
``renderRichResult()`` on the page relies on for pandas).

Only module-level statements are wrapped. A bare expression inside a ``for`` or
a ``def`` displays nothing, exactly as in Jupyter; ``display()`` is the escape
hatch there, and is installed on ``builtins``. A trailing semicolon suppresses
one result, also as in Jupyter.

Why an AST wrap and not ``sys.displayhook``
-------------------------------------------
``sympy.init_printing()`` *replaces* ``sys.displayhook`` when it runs outside
IPython, and students copy that call out of notebook material constantly. A
displayhook design would therefore lose to the one library this feature exists
for. The AST wrap is immune, and is what IPython itself does
(``run_ast_nodes`` with ``ast_node_interactivity='all'``).

Why not a second text-level rewrite
-----------------------------------
``vpython/_async_transform.py`` already rewrites the source textually to insert
``async``/``await``. Composing two textual passes over the same source goes
wrong on column offsets. This module parses that pass's *output* instead — it
preserves line numbers, so the AST it produces still points at the student's
lines.

Everything here is pure standard library and unit-testable outside Pyodide,
except ``run_program()``, which imports ``pyodide.code`` lazily.
"""

import ast
import builtins
import linecache
import sys

# Name the wrapper call resolves at run time. Installed on builtins rather than
# in the program's globals() so that Clear memory — which restores globals from
# a bootstrap snapshot — cannot remove it, and so it never shows up in the
# Variables panel.
_HOOK_NAME = '__trinket_display_hook__'

# Filename the runner compiles under. Matches Pyodide's own default, which the
# page's traceback filter depends on.
_MAIN_FILENAME = '<exec>'

# Guard for pathological nesting when checking whether a container's leaves can
# all typeset themselves.
_MAX_CONTAINER_DEPTH = 6

_sink = None            # callable(dict) installed by the host
_source_lines = []      # source to ECHO — what the student actually wrote
_exec_lines = []        # source that was PARSED — column offsets refer to this
_expr_spans = {}        # lineno -> end_lineno, recorded by wrap_module()


# ---------------------------------------------------------------- installation

def install(sink, source=''):
    """Install the display machinery. Called by the host once at bootstrap.

    ``sink`` receives one dict per displayed object. The host supplies a
    callback that forwards to JavaScript: a direct call on the main thread, a
    posted ``rich`` message in the worker.
    """
    global _sink
    _sink = sink
    set_source(source)
    builtins.display = display
    setattr(builtins, _HOOK_NAME, _hook)


def set_source(source, exec_source=None):
    """Record the program about to run.

    Two sources, because they can differ. ``source`` is what the student wrote
    and is what the echo shows. ``exec_source`` is the text actually parsed —
    after ``_async_transform``'s textual ``await ``/``async `` insertions, where
    those apply — and is what any COLUMN offset from the AST refers to.

    Line numbers are identical in both (the transform never adds or removes
    lines), so only column-based lookups need the distinction. Getting it wrong
    is silent: an ``end_col_offset`` from the transformed tree, indexed into the
    original line, lands past the end and simply finds nothing there.
    """
    global _source_lines, _exec_lines, _expr_spans
    _source_lines = (source or '').splitlines()
    _exec_lines = (exec_source or source or '').splitlines()
    _expr_spans = {}


# ------------------------------------------------------------------ classifier

def _strip_delimiters(latex):
    """Remove the ``$…$`` / ``$$…$$`` wrapper ``_repr_latex_`` conventionally adds.

    ``\\displaystyle`` is deliberately kept: SymPy emits it, and the renderer
    runs with ``displayMode: false`` so it is what makes the output read as
    display math.
    """
    text = latex.strip()
    for delim in ('$$', '$'):
        if len(text) > 2 * len(delim) and text.startswith(delim) and text.endswith(delim):
            inner = text[len(delim):-len(delim)]
            # '$x$ and $y$' is not one delimited block; stripping its ends would
            # produce 'x$ and $y', which is worse than leaving it alone.
            if '$' in inner:
                return text
            return inner.strip()
    return text


def _own_latex(obj):
    """LaTeX from ``obj._repr_latex_()``, or None.

    ``_repr_latex_`` may legitimately return a string, None (meaning "I decline
    to render this one"), or an IPython-style ``(data, metadata)`` tuple.

    The lookup is on the TYPE, not the instance, and the whole thing is
    guarded. Both matter, because the object is student-written:

    * A class with a ``__getattr__`` that raises something other than
      AttributeError — ``def __getattr__(self, n): return self.cache[n]``
      raising KeyError is an everyday student bug — would otherwise propagate
      out of the hook and kill a program that ran fine with the flag off.
      A type lookup never triggers instance ``__getattr__`` at all. This is
      what IPython's formatters do, for the same reason.
    * A ``__getattr__`` that returns a callable for ANY name (the fluent-proxy
      pattern) would otherwise "typeset" whatever that callable returned —
      echoing garbage for an object that has no LaTeX form.
    * A property or descriptor that raises, and any raising implementation, is
      caught: the feature declines to render, it does not break the run.
    """
    try:
        if getattr(type(obj), '_repr_latex_', None) is None:
            return None
        result = obj._repr_latex_()
    except Exception:
        return None
    if isinstance(result, tuple) and result:
        result = result[0]
    if not isinstance(result, str) or not result.strip():
        return None
    return _strip_delimiters(result)


def _can_typeset(obj, depth=0):
    """True if obj — or, for a container, every leaf of it — has _repr_latex_.

    Containers are matched by EXACT type, not isinstance. A subclass of list or
    dict can override ``__iter__``, ``__len__``, ``__bool__`` or ``items()``
    with anything at all, including something that raises, and walking it would
    put student code on the hook's call path. Exact types lose nothing real:
    SymPy's own ``Tuple`` and ``Dict`` are Printable, so they typeset through
    ``_own_latex`` rather than this walk.
    """
    if depth > _MAX_CONTAINER_DEPTH:
        return False
    kind = type(obj)
    try:
        if kind is list or kind is tuple:
            return bool(obj) and all(_can_typeset(o, depth + 1) for o in obj)
        if kind is dict:
            return bool(obj) and all(
                _can_typeset(k, depth + 1) and _can_typeset(v, depth + 1)
                for k, v in obj.items())
    except Exception:
        return False
    if kind is str or kind is bytes:
        return False
    return _own_latex(obj) is not None


def _container_latex(obj):
    """LaTeX for a list/tuple/dict of typesettable objects, via sympy.latex().

    SymPy's containers have no ``_repr_latex_`` of their own, so this is the
    only route for ``[sol1, sol2]``. SymPy is never imported here: if the
    student's program has not imported it, there is nothing this could be
    printing, and importing it costs ~3.3 s.
    """
    sympy = sys.modules.get('sympy')
    latex = getattr(sympy, 'latex', None) if sympy is not None else None
    if latex is None:
        return None
    try:
        result = latex(obj)
    except Exception:
        return None
    if not isinstance(result, str) or not result.strip():
        return None
    return _strip_delimiters(result)


def _latex_of(obj):
    """Return a LaTeX string with no ``$`` delimiters, or None to stay silent.

    None is the answer for ints, strings, matplotlib return values, module
    docstrings and everything else that is not self-typesetting — which is what
    keeps this feature a no-op for existing trinkets.
    """
    kind = type(obj)
    if kind is list or kind is tuple or kind is dict:
        return _container_latex(obj) if _can_typeset(obj) else None
    if kind is str or kind is bytes:
        return None
    return _own_latex(obj)


# --------------------------------------------------------------------- payload

def _one_line(text):
    """Collapse to a single line: the text fallback sits in one console line."""
    return ' '.join(text.split())


def _text_of(obj):
    """``str(obj)`` — the form that pastes back into Python code."""
    try:
        return _one_line(str(obj))
    except Exception:
        return ''


def _source_at(lineno):
    """The student's source for the statement starting at ``lineno``.

    Uses the span recorded at wrap time so a statement spread over several
    physical lines echoes in full, and so a line carrying two statements
    (``sol = dsolve(eq); sol``) echoes as the student wrote it.
    """
    if not lineno or lineno < 1 or lineno > len(_source_lines):
        return ''
    end = _expr_spans.get(lineno, lineno)
    if end < lineno or end > len(_source_lines):
        end = lineno
    segment = _source_lines[lineno - 1:end]
    while segment and not segment[-1].strip():
        segment.pop()
    if not segment:
        return ''
    # Drop the common indentation so a nested display() does not echo with a
    # ragged left edge; the card indents the math itself.
    indents = [len(s) - len(s.lstrip()) for s in segment if s.strip()]
    cut = min(indents) if indents else 0
    return '\n'.join(s[cut:].rstrip() for s in segment)


def _payload(obj, latex, lineno=None, source=None):
    return {
        # What kind of rich output this is. The JS side dispatches on it, so a
        # second kind (an _repr_html_ table, say) is additive rather than a
        # renegotiation of the envelope. Matches the idiom already used by the
        # worker `figure` protocol and the Variables snapshot.
        'kind': 'math',
        'latex': latex,
        'text': _text_of(obj),
        'lineno': lineno,
        'source': source if source is not None else _source_at(lineno),
    }


def _emit(obj, lineno=None, source=None):
    """Classify and hand off. Silent unless the object can typeset itself."""
    latex = _latex_of(obj)
    if latex is None or _sink is None:
        return
    try:
        _sink(_payload(obj, latex, lineno, source))
    except Exception:
        # A failing sink must never surface as an error in the student's
        # program: their code did nothing wrong.
        pass


# ------------------------------------------------------------------ entry points

def _hook(value, lineno):
    """Wrapper installed around every module-level expression statement.

    Returns its argument, so the program behaves exactly as it would without
    the wrap — including Pyodide's last-expression return value.
    """
    _emit(value, lineno)
    return value


def display(*objs):
    """Display objects explicitly. The escape hatch inside loops and functions.

    A real notebook idiom, so students transplanting code from Jupyter find it
    already works.
    """
    lineno = None
    source = None
    try:
        frame = sys._getframe(1)
    except Exception:
        frame = None
    if frame is not None:
        lineno = frame.f_lineno
        filename = frame.f_code.co_filename
        if filename == _MAIN_FILENAME:
            source = _source_at(lineno)
        else:
            # A secondary .py file the program imported: read it from
            # linecache and say where it came from, since the line number
            # means nothing against the code window.
            line = linecache.getline(filename, lineno).rstrip()
            short = filename.rsplit('/', 1)[-1]
            source = ('%s:%d  %s' % (short, lineno, line.strip())) if line else ''
    for obj in objs:
        _emit(obj, lineno, source)


# ------------------------------------------------------------------- AST wrap

def _suppressed_by_semicolon(node):
    """True if this statement's source ends with ``;`` — Jupyter's suppression.

    Students transplant notebook code, where a trailing semicolon means "compute
    this but do not show it". Pyodide's own ``quiet_trailing_semicolon`` only
    suppresses the RETURN value of the whole program, so without this a bare
    ``expr;`` would still display and the idiom would appear broken.

    Deliberately strict: the ``;`` must be the last thing on the line apart from
    whitespace or a comment. ``a = 1; x`` and ``x; y`` therefore still display
    ``x`` — there the semicolon is separating statements, not suppressing one,
    and guessing wrong in that direction would silently swallow output.
    """
    end = getattr(node, 'end_lineno', None)
    col = getattr(node, 'end_col_offset', None)
    if not end or col is None or end < 1 or end > len(_exec_lines):
        return False
    try:
        # _exec_lines, NOT _source_lines: the offset comes from the tree that was
        # parsed, and the async transform shifts columns on the lines it touches.
        # ast column offsets are UTF-8 byte offsets, so slice the encoded line.
        rest = _exec_lines[end - 1].encode('utf-8')[col:].decode('utf-8')
    except Exception:
        return False
    rest = rest.lstrip()
    if not rest.startswith(';'):
        return False
    tail = rest[1:].strip()
    return tail == '' or tail.startswith('#')


def wrap_module(tree):
    """Wrap each module-level ``Expr`` in a call to the display hook.

    Mutates and returns ``tree``. Only ``tree.body`` is walked: expressions
    nested in ``if``/``for``/``while``/``with``/``def``/``class`` bodies are
    left alone, which is what makes a bare expression inside a loop silent.

    A leading string constant is left alone too. Wrapping it would be harmless
    for display (the classifier ignores strings) but it would stop the compiler
    treating it as a docstring, and ``__doc__`` would silently become None.
    """
    body = getattr(tree, 'body', None)
    if not isinstance(body, list):
        return tree
    for index, node in enumerate(body):
        if not isinstance(node, ast.Expr):
            continue
        if index == 0 and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            continue
        if _suppressed_by_semicolon(node):
            continue
        call = ast.Call(
            func=ast.Name(id=_HOOK_NAME, ctx=ast.Load()),
            args=[node.value, ast.Constant(value=node.lineno)],
            keywords=[])
        wrapped = ast.Expr(value=call)
        ast.copy_location(call, node.value)
        ast.copy_location(call.func, node.value)
        ast.copy_location(wrapped, node)
        _expr_spans[node.lineno] = getattr(node, 'end_lineno', None) or node.lineno
        body[index] = wrapped
    ast.fix_missing_locations(tree)
    return tree


# ----------------------------------------------------------------- the runner

async def run_program(source, globals_, filename=_MAIN_FILENAME):
    """Run a program with the display hook in place. Pyodide only.

    ``source`` is the program text *after* the async transform, so top-level
    ``await`` may be present and line numbers still match the code window.

    Goes through ``pyodide.code.CodeRunner`` rather than compiling by hand so
    the ``<exec>`` filename and the ``last_expr`` return mode match what
    ``runPythonAsync`` would have produced — the page's traceback filter
    depends on the former and ``renderRichResult()`` on the latter.
    """
    from pyodide.code import CodeRunner

    runner = CodeRunner(
        source,
        mode='exec',
        return_mode='last_expr',
        filename=filename,
        flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    wrap_module(runner.ast)
    runner.compile()
    return await runner.run_async(globals_)
