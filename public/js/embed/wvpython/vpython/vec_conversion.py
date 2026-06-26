from .vec_js import vector_js as vector
from .vector import vector as vec_orig

from js import vector as js_vec
from pyodide.ffi import to_js

"""
Convert vectors back and forth between python and js
"""

py_vec = vector

def py2js_vec(v):
    if isinstance(v, list) or isinstance(v,tuple):
        if len(v) == 3:
            if isinstance(v[0], float) or isinstance(v[0], int):
                return js_vec(v[0], v[1], v[2])
        if len(v)>0:
            if isinstance(v[0], vector) or isinstance(v[0], vec_orig):
                return to_js(list(map(lambda vi: js_vec(vi), v)))
    return js_vec(v.x, v.y, v.z)

def js2py_vec(v, jsObj=None):
    return py_vec(v.x, v.y, v.z, jsObj=jsObj)
