from .core_funcs import rate
from .core_funcs import pyramid, ring, sphere, box, cylinder, cone, helix, vertex, compound, curve
from .core_funcs import js_vec, arrow, label, scene
from .core_funcs import ellipsoid, text, distant_light, local_light, button
from .core_funcs import slider, radio, checkbox, menu, wtext, points, get_library
from .core_funcs import triangle, quad, extrusion, canvas, attach_light, copy
from .core_funcs import graph, gcurve, gvbars, ghbars, gdots, js_debug, simple_sphere, js_window
from .shapespaths_orig import *
from .vector import adjust_axis, adjust_up, comp, cross, diff_angle, dot, hat, mag, mag2, norm, object_rotate, proj, rotate
from .vec_js import vector_js as vector
from .color import color
from js import textures, bumpmaps, winput
from js import Date as _js_Date

# MathJax is loaded by the runner only when the program references it (see
# +page.svelte). get_mathjax() returns a proxy that keeps the classic
# `MathJax.Hub.Queue([...])` idiom working under Pyodide, or None when MathJax
# isn't loaded. Do NOT use `from js import MathJax` — that raises ImportError
# when MathJax isn't loaded, breaking every other program.
from ._mathjax import get_mathjax
MathJax = get_mathjax()

# Classic GlowScript programs run in a JavaScript global namespace where
# `window` is available. Expose the browser window under the same name, while
# keeping the existing js_window alias.
window = js_window

def Date(*args):
    """JavaScript Date, as used by GlowScript programs (e.g. the Stonehenge
    example). Constructs a real Date — Date() / Date(year, month, day, ...) —
    so methods like getFullYear() and getTime() work. (Calling the bare JS
    Date as a function would otherwise just return a string.)"""
    return _js_Date.new(*args)

from js import window as _input_window

def input(prompt=''):
    """Prompt the user for input in the browser.

    Python's builtin input() reads stdin, which doesn't exist in the browser
    (it raises OSError: [Errno 29] I/O error). GlowScript gets keyboard input
    via window.prompt() (that is what the winput widget uses), so input() does
    the same here. Returns the entered text as a string ('' if the user
    cancels), so int(input(...)) etc. work as written.
    """
    result = _input_window.prompt(str(prompt))
    return '' if result is None else str(result)

import asyncio
import time
clock = time.perf_counter

async def sleep(dt):
    """Pause for dt seconds without blocking the browser UI.

    The async source transformer rewrites user calls to sleep(...) as
    await sleep(...), and promotes containing functions as needed, matching the
    blocking-looking GlowScript idiom while using Pyodide's event loop.
    """
    await asyncio.sleep(dt)

vec = vector
py_vec = vector

__all__ = ["sphere", "box", "color", "vec", "py_vec", "js_vec", "vector", "rate","sleep",
"cylinder", "arrow", "cone", "helix", 'adjust_axis', 'adjust_up', 'comp', 'cross', 'diff_angle', 'dot',
'hat', 'mag', 'mag2', 'norm', 'object_rotate', 'proj', 'rotate', 'scene', 'distant_light','label',
'ellipsoid', 'pyramid', 'ring', 'text', 'textures', 'attach_light', 'local_light','button',
'slider', 'wtext', 'radio', 'checkbox', 'menu', 'curve', 'points','vertex', 'triangle','quad',
'extrusion', 'paths','shapes', 'canvas','textures', 'compound','color','js_debug', 'winput',
'graph', 'gcurve', 'gvbars', 'ghbars', 'gdots','bumpmaps', 'clock', 'simple_sphere', 'get_library',
'js_window', 'window', 'copy', 'Date', 'MathJax', 'input']
