"""
Tests for vpython/_async_transform.py — the AST transformer that fixes Issue #1
(rate()/get_library()/scene.waitfor() inside user functions causing
"'await' outside async function").

The module is loaded directly from its file so we do NOT trigger
vpython/__init__.py (which does `from js import ...` and only works inside
Pyodide). The transformer itself must stay pure-stdlib.
"""
import ast
import importlib.util
import os

_HERE = os.path.dirname(__file__)
# trinket vendors the wmWVPRunner vpython package under public/js/embed/wvpython/.
# This test file is kept in sync with wmWVPRunner's test/test_async_transform.py
# (only this path differs).
_MODULE_PATH = os.path.join(
    _HERE, '..', '..', '..',
    'public', 'js', 'embed', 'wvpython', 'vpython', '_async_transform.py')

_spec = importlib.util.spec_from_file_location('_async_transform', _MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
transform_source = _mod.transform_source


def t(src):
    """Transform and return normalized output source."""
    return transform_source(src)


def is_valid_python(src):
    try:
        ast.parse(src)
        return True
    except SyntaxError:
        return False


# --- base awaitables at top level -------------------------------------------

def test_toplevel_rate_is_awaited():
    out = t("rate(60)\n")
    assert "await rate(60)" in out


def test_toplevel_get_library_is_awaited():
    out = t("get_library('http://x/lib.js')\n")
    assert "await get_library(" in out


def test_toplevel_sleep_is_awaited():
    out = t("sleep(0.5)\n")
    assert "await sleep(0.5)" in out


def test_toplevel_waitfor_is_awaited():
    out = t("scene.waitfor('click')\n")
    assert "await scene.waitfor(" in out


def test_rate_in_while_loop_toplevel():
    out = t("while True:\n    rate(60)\n")
    assert "await rate(60)" in out


# --- function promotion ------------------------------------------------------

def test_rate_in_def_makes_it_async_and_awaits_call():
    out = t("def move():\n    rate(60)\n\nmove()\n")
    assert "async def move" in out
    assert "await rate(60)" in out
    assert "await move()" in out


def test_sleep_in_def_makes_it_async_and_awaits_call():
    out = t("def pause():\n    sleep(0.5)\n\npause()\n")
    assert "async def pause" in out
    assert "await sleep(0.5)" in out
    assert "await pause()" in out


def test_function_without_trigger_stays_sync():
    out = t("def hello():\n    print('hi')\n\nhello()\n")
    assert "async def hello" not in out
    assert "await hello()" not in out


def test_transitive_promotion():
    src = (
        "def g():\n    rate(60)\n\n"
        "def f():\n    g()\n\n"
        "f()\n"
    )
    out = t(src)
    assert "async def g" in out
    assert "async def f" in out
    assert "await g()" in out
    assert "await f()" in out


def test_nested_function_promotion():
    src = (
        "def outer():\n"
        "    def inner():\n"
        "        rate(60)\n"
        "    inner()\n"
        "outer()\n"
    )
    out = t(src)
    assert "async def inner" in out
    assert "async def outer" in out
    assert "await inner()" in out
    assert "await outer()" in out


# --- methods -----------------------------------------------------------------

def test_method_promotion():
    src = (
        "class Ball:\n"
        "    def step(self):\n"
        "        rate(60)\n"
        "    def run(self):\n"
        "        self.step()\n"
    )
    out = t(src)
    assert "async def step" in out
    assert "async def run" in out
    assert "await self.step()" in out


# --- builtins must never be awaited -----------------------------------------

def test_builtins_not_awaited():
    out = t("print(len(range(10)))\n")
    assert "await" not in out


# --- idempotency -------------------------------------------------------------

def test_already_async_not_double_wrapped():
    src = "async def move():\n    await rate(60)\n"
    out = t(src)
    assert out.count("await rate(60)") == 1
    assert "await await" not in out
    assert is_valid_python(out)


def test_caller_of_user_async_def_is_awaited():
    src = (
        "async def move():\n    await rate(60)\n\n"
        "def loop():\n    move()\n\n"
        "loop()\n"
    )
    out = t(src)
    # move is already async; loop calls it so loop must become async + awaited
    assert "async def loop" in out
    assert "await move()" in out
    assert "await loop()" in out


# --- callbacks: a reference (not a call) must not be awaited -----------------

def test_function_reference_not_awaited():
    src = (
        "def onclick(evt):\n    rate(60)\n\n"
        "scene.bind('mousedown', onclick)\n"
    )
    out = t(src)
    assert "async def onclick" in out
    # onclick is passed by reference, not called -> must stay a bare name
    assert "await onclick" not in out


# --- output is always valid python ------------------------------------------

def test_output_parses():
    src = (
        "def g():\n    rate(60)\n\n"
        "def f():\n    g()\n    rate(30)\n\n"
        "for i in range(3):\n    f()\n"
    )
    out = t(src)
    assert is_valid_python(out)


def test_syntax_error_returns_original():
    src = "def broken(:\n    pass\n"
    out = t(src)
    assert out == src


# --- line/comment fidelity (matters for error tracebacks) -------------------

def test_line_numbers_preserved():
    src = (
        "#Web VPython 3.2\n"      # 1
        "ball = sphere()\n"        # 2
        "\n"                        # 3
        "def move():\n"            # 4
        "    rate(60)\n"           # 5
        "\n"                        # 6
        "move()\n"                 # 7
    )
    out = t(src)
    assert out.count("\n") == src.count("\n")
    out_lines = out.splitlines()
    # rate() is still on line 5 (index 4)
    assert "rate(60)" in out_lines[4]
    assert "await" in out_lines[4]


def test_comments_preserved():
    src = (
        "def move():  # animate\n"
        "    rate(60)  # frame cap\n"
        "move()\n"
    )
    out = t(src)
    assert "# animate" in out
    assert "# frame cap" in out


def test_non_ascii_before_call_is_safe():
    # a unicode identifier/comment earlier on lines must not corrupt offsets
    src = (
        "vel = vector(1, 0, 0)  # velocité\n"
        "def step():\n"
        "    rate(60)\n"
        "step()\n"
    )
    out = t(src)
    assert "velocité" in out
    assert "await rate(60)" in out
    assert "await step()" in out
    assert is_valid_python(out)


def test_decorated_function_promoted_correctly():
    src = (
        "@somedecorator\n"
        "def move():\n"
        "    rate(60)\n"
        "move()\n"
    )
    out = t(src)
    assert "async def move" in out
    assert "@somedecorator" in out
    assert is_valid_python(out)


# --- namespaced module primitives (import vpython as vp) ---------------------

def test_namespaced_rate_is_awaited():
    out = t("import vpython as vp\nvp.rate(60)\n")
    assert "await vp.rate(60)" in out


def test_namespaced_sleep_and_get_library_awaited():
    out = t("import vpython as vp\nvp.sleep(0.5)\nvp.get_library('x')\n")
    assert "await vp.sleep(0.5)" in out
    assert "await vp.get_library('x')" in out


def test_full_module_name_awaited():
    out = t("import vpython\nvpython.rate(60)\n")
    assert "await vpython.rate(60)" in out


def test_namespaced_rate_in_def_promotes_and_awaits():
    out = t("import vpython as vp\ndef spin():\n    vp.rate(60)\n\nspin()\n")
    assert "async def spin" in out
    assert "await vp.rate(60)" in out
    assert "await spin()" in out


# --- false-positive guard: look-alike attrs on non-vpython objects -----------

def test_unrelated_rate_attr_not_awaited():
    src = (
        "import vpython as vp\n"
        "class Meter:\n    def rate(self):\n        return 1\n\n"
        "m = Meter()\nm.rate()\n"
    )
    assert "await m.rate" not in t(src)


def test_unrelated_sleep_attr_not_awaited():
    src = "import vpython as vp\nimport time\nclk = time\nclk.sleep(1)\n"
    assert "await clk.sleep" not in t(src)


if __name__ == "__main__":
    # Dependency-free runner so CI can invoke `python3 test/test_async_transform.py`
    # (also works under pytest). Exits non-zero on any failure.
    import sys
    _fns = [v for k, v in sorted(globals().items())
            if k.startswith("test_") and callable(v)]
    _failed = 0
    for _fn in _fns:
        try:
            _fn()
            print("PASS", _fn.__name__)
        except AssertionError as _e:
            _failed += 1
            print("FAIL", _fn.__name__, "-", _e or "assertion failed")
        except Exception as _e:  # noqa: BLE001
            _failed += 1
            print("ERROR", _fn.__name__, "-", repr(_e))
    print()
    print("%d/%d passed" % (len(_fns) - _failed, len(_fns)))
    sys.exit(1 if _failed else 0)
