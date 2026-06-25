"""Expose the JavaScript MathJax global to Python.

Web VPython / GlowScript programs typeset math with the classic idiom:

    MathJax.Hub.Queue(["Typeset", MathJax.Hub])

In classic GlowScript that list is a native JS array, which is what
``Hub.Queue`` expects. Under Pyodide, a Python ``list`` passed to a JS function
is NOT converted to a JS array — it arrives as an opaque PyProxy, so MathJax
reads ``callback[0]`` as ``undefined``, fails to recognize the "Typeset"
command, and silently does nothing.

These thin proxies keep the idiom working: ``Hub.Queue`` converts list/tuple
arguments to real JS arrays (unwrapping any nested ``MathJax.Hub`` back to its
raw JS object first). Everything else is delegated to the underlying JS
objects unchanged.
"""
from pyodide.ffi import to_js


class _HubProxy:
    """Wraps MathJax.Hub so Queue() accepts Python sequences."""

    def __init__(self, hub):
        object.__setattr__(self, '_hub', hub)

    def Queue(self, *args):
        converted = []
        for arg in args:
            if isinstance(arg, (list, tuple)):
                seq = [x._hub if isinstance(x, _HubProxy) else x for x in arg]
                converted.append(to_js(seq))
            elif isinstance(arg, _HubProxy):
                converted.append(arg._hub)
            else:
                converted.append(arg)
        return self._hub.Queue(*converted)

    def __getattr__(self, name):
        return getattr(self._hub, name)

    def __setattr__(self, name, value):
        setattr(self._hub, name, value)


class _MathJaxProxy:
    """Wraps the MathJax global; .Hub returns a list-aware _HubProxy."""

    def __init__(self, mathjax):
        object.__setattr__(self, '_mathjax', mathjax)

    @property
    def Hub(self):
        return _HubProxy(self._mathjax.Hub)

    def __getattr__(self, name):
        return getattr(self._mathjax, name)

    def __setattr__(self, name, value):
        setattr(self._mathjax, name, value)


def get_mathjax():
    """Return a MathJax proxy if MathJax is loaded in the page, else None.

    The runner only loads MathJax when the program references it, so this is
    None for programs that don't use math.
    """
    try:
        from js import window
        mathjax = getattr(window, 'MathJax', None)
    except Exception:
        mathjax = None
    if mathjax is None:
        return None
    return _MathJaxProxy(mathjax)
