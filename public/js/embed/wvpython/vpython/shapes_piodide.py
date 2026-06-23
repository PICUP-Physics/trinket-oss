
from js import Object

from pyodide.ffi import to_js

from .vec_js import vector_js as vector
from .vector import vector as vec_orig

vec = vector

from .vec_conversion import py2js_vec

# List of names that are exported imported from this module with import *
__all__ = ['convertPyVecsToJSList']

def convertPyVecsToJSList(pyVecList, root=True):
    result = []
    for item in pyVecList:
        if isinstance(item, list) or isinstance(item, tuple):
            result.append(convertPyVecsToJSList(item, root=False))
        elif isinstance(item, vector) or isinstance(item, vec_orig): # I don't think this should be neccessary, but Hmm....
            result.append(py2js_vec(item))
        else:
            result.append(item)
    if root:
        result = to_js(result, dict_converter=Object.fromEntries)
    return result

