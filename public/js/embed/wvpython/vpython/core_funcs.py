from signal import raise_signal
import asyncio
from inspect import Parameter, isawaitable, signature
from js import sphere as js_sphere, box as js_box, shapes, paths, vec as js_vec, rate
from js import cylinder as js_cylinder, arrow as js_arrow, cone as js_cone, helix as js_helix
from js import label as js_label, scene as js_scene, textures
from js import pyramid as js_pyramid, ring as js_ring, text as js_text
from js import button as js_button, distant_light as js_distant_light, local_light as js_local_light
from js import slider as js_slider, wtext as js_wtext, radio as js_radio, checkbox as js_checkbox
from js import menu as js_menu, curve as js_curve, Object, get_library as js_get_library
from js import points as js_points, extrusion as js_extrusion, simple_sphere as js_simple_sphere
from js import window as js_window, fontloading as js_fontloading, waitforfonts as js_waitforfonts
from js import quad as js_quad, vertex as js_vertex, triangle as js_triangle, ellipsoid as js_ellipsoid
from js import canvas as js_canvas, attach_light as js_attach_light, compound as js_compound
from js import graph as js_graph, gcurve as js_gcurve, gvbars as js_gvbars, gdots as js_gdots, ghbars as js_ghbars

from pyodide.ffi import create_proxy, to_js

from .curveArgs import getStdForm
from .vec_js import vector_js as vector

from .vec_conversion import js2py_vec, py2js_vec
from .shapes_piodide import convertPyVecsToJSList

class GSRegistry(object):
    """
    Manage a registry of objects so we can look up the python object
    from the corresponding javascript object.
    """
    def __init__(self):
        self.counter = 0
        self.registry = {}

    def register(self, obj):
        result = self.counter
        self.registry[self.counter] = obj
        self.counter += 1
        return result

    def get(self, index):
        result = self.registry.get(index,None)
        if result is None:
            raise Exception("GSRegistry: object with index %d not found" % index)
        return result

gsRegistry = GSRegistry()
gsRegKey = '__gsIndex__'

def js_debug(*args, convert=True):
    if convert:
        args = to_js(args)
    js_window.__reportScriptError(args)

async def get_library(url):
    """
    Load a library from a url and then fetch varname from the window object. If you need to convert from native js objec to python, pass in a constructor function.
    """
    obj = None # maybe return nothing
    try:
        await js_get_library(url)
    except Exception as e:
        raise Exception("Error loading library %s: %s" % (url, e))

def translate_kwargs_rest(kwargs, notAttrs):
    # Handle everything else
    for attr in kwargs:
        if attr not in notAttrs:
            kwargs[attr] = to_js(kwargs[attr], dict_converter=Object.fromEntries)

    return kwargs

def translate_kwargs_nest(kwargs, nestAttrs):
    """
    Handle nested structures of lists of vectors.
    """
    for attr in nestAttrs:
        if attr in kwargs:
            kwargs[attr] = convertPyVecsToJSList(kwargs[attr])
    return kwargs

def translate_kwargs_vecs(kwargs, vecAttrs):
    # Translate the vecAttrs from kwargs to js vectors.
    for attr in vecAttrs:
        if attr in kwargs:
            kwargs[attr] = py2js_vec(kwargs[attr])
    return kwargs

def translate_kwargs_lists(kwargs, listAttrs):
    for attr in listAttrs:
        if attr in kwargs:
            kwargs[attr] = to_js(kwargs[attr])
    return kwargs

def event_callback_proxy(py_func):
    """Create a JS callback proxy for a Python event handler.

    GlowScript allows widget callbacks such as button(bind=f) where f can be
    written either as f() or f(evt). JavaScript widgets pass an event/control
    object to the callback, so a direct create_proxy(f) breaks zero-argument
    handlers with "takes 0 positional arguments but 1 was given". Inspect the
    handler and drop JS callback arguments only when the Python function cannot
    accept any positional argument.

    The async transformer may also promote callbacks to async def when they use
    rate(), scene.waitfor(), or get_library(). JavaScript will not await a
    returned Python coroutine, so schedule awaitable callback results on the
    browser/Pyodide event loop.
    """
    def finish_callback_result(result):
        if isawaitable(result):
            asyncio.create_task(result)
            return None
        return result

    def callback_with_args(*args):
        return finish_callback_result(py_func(*args))

    try:
        params = signature(py_func).parameters.values()
        accepts_varargs = any(p.kind == Parameter.VAR_POSITIONAL for p in params)
        positional_count = sum(
            1 for p in params
            if p.kind in (Parameter.POSITIONAL_ONLY, Parameter.POSITIONAL_OR_KEYWORD)
        )
    except Exception:
        return create_proxy(callback_with_args)

    if accepts_varargs or positional_count > 0:
        return create_proxy(callback_with_args)

    def callback_no_args(*_args):
        return finish_callback_result(py_func())

    return create_proxy(callback_no_args)

def translate_kwargs_funcs(kwargs, funcAttrs):
    for attr in funcAttrs:
        if attr in kwargs:
            kwargs[attr] = event_callback_proxy(kwargs[attr])
    return kwargs

class glowProxy(object):
    """
    A proxy for a glowscript library object. Most attributes are stored as js objects/attributes of
    the mirrored javascript object handled/used by the glowscript library.

    vecAttrs is a list of names of vector attributes.
    listAttrs is a list of names of list attributes (e.g., lights, points, etc.)
    funcAttrs is a list of names of function attributes (e.g., bind)
    oType is the name of the JS object type (e.g., sphere...)
    GP_keys are the names of attributes stored in self.__dict__, not proxied from jsObj.
    """

    GP_defaults = {'vecAttrs':[], 'oType':None, 'jsObj':None, 'listAttrs':[], 'funcAttrs':[], 'nestAttrs':[]}
    GP_keys = list(GP_defaults.keys())

    def __init__(self, *args, factory=None, jsObj=None, **kwargs):
        """
        factory is JS function that constructs the jsObj.
        kwArgs are the keyword arguments for the factory.
        args are the positional arguments for the factory.
        """
        for attr in glowProxy.GP_keys:
            self.__dict__[attr] = kwargs.get(attr, glowProxy.GP_defaults.get(attr, None)) # grab kwargs for GP_keys

        kwargs = self.translate_all_kwargs(kwargs)

        for attr in glowProxy.GP_keys:
            if attr in kwargs:
                del kwargs[attr] # don't pass these to js

        if jsObj is not None:
            self.jsObj = jsObj
            if (not hasattr(jsObj, gsRegKey)):
                setattr(jsObj, gsRegKey, gsRegistry.register(self))
        elif factory is not None:
            self.jsObj = factory(*args, **kwargs)
            setattr(self.jsObj, gsRegKey, gsRegistry.register(self))
        else:
            raise Exception("glowProxy: must specify either factory or jsObj")


    def translate_all_kwargs(self, kwargs):
        """
        Convert kwargs to save js objects.
        """
        kwargs = translate_kwargs_vecs(kwargs, self.vecAttrs)
        kwargs = translate_kwargs_lists(kwargs, self.listAttrs)
        kwargs = translate_kwargs_funcs(kwargs, self.funcAttrs)
        kwargs = translate_kwargs_nest(kwargs, self.nestAttrs)
        kwargs = translate_kwargs_rest(kwargs, self.vecAttrs + self.listAttrs + self.funcAttrs + self.nestAttrs)
        return kwargs

    def __setattr__(self, name, value):
        if name in glowProxy.GP_keys:
            self.__dict__[name] =  value
        elif name in self.vecAttrs:
            setattr(self.jsObj, name, py2js_vec(value))
        elif name in self.listAttrs:
            setattr(self.jsObj, name, to_js(value))
        else:
            setattr(self.jsObj, name, to_js(value, dict_converter=Object.fromEntries))
    
    def __getattr__(self, name):
        if name in glowProxy.GP_keys:
            return self.__dict__.get(name, 
                glowProxy.GP_defaults.get(name, None))
        elif name in self.vecAttrs:
            return js2py_vec(getattr(self.jsObj, name), jsObj=getattr(self.jsObj,name)) # keep jsObj embedded in pyObj
        else:
            result = getattr(self.jsObj, name)
            if hasattr(result,gsRegKey):
                return gsRegistry.get(getattr(result,gsRegKey))
            return result

    def __str__(self):
        return "glowProxy: " + self.oType

    def rotate(self, *args, **kwargs): # We may need to intercept certain functions and assignements to do js/py vec conversions
        """
        Rotate the object.
        """
        kwargs = translate_kwargs_vecs(kwargs=kwargs, vecAttrs=['axis','origin'])
        self.jsObj.rotate(*args, **kwargs)
        return self

    def append(self, *args, **kwargs):
        """
        Append to the object.
        """
        kwargs = translate_kwargs_vecs(kwargs=kwargs, vecAttrs=['origin'])
        self.jsObj.append(*args, **kwargs)
        return self

    def modify(self, *args, **kwargs):
        """
        Modify the object.
        """
        kwargs = self.translate_all_kwargs(kwargs)
        self.jsObj.modify(*args, **kwargs)
        return self
    
    def clone(self, *args, **kwargs):
        if 'pos' in kwargs:
            kwargs['pos'] = py2js_vec(kwargs['pos'])
        cjs = self.jsObj.clone(*args, **kwargs)
        ret = type(self)(*args, **kwargs, jsObj=cjs)
        return ret

    def delete(self):
        """Remove this object from the scene.

        Desktop VPython and GlowScript write obj.delete(), but JavaScript
        reserves `delete`, so classic GlowScript rewrites .delete -> .remove in
        preprocessing. Two removal mechanisms exist in the library:
          * canvas/scene, graphs and widgets expose a remove() method;
          * 3-D primitives (box, sphere, ...) have no remove() — they are
            removed by setting visible = False and marking them deleted
            (the same thing compound() does to its constituent objects).
        Note: setattr is used for __deleted to avoid Python name-mangling.
        """
        jsObj = self.jsObj
        remove = getattr(jsObj, 'remove', None)
        if remove is not None:
            remove()
        else:
            jsObj.visible = False
            setattr(jsObj, '__deleted', True)

class sphere(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos','color','size','trail_color'], oType='sphere', factory=js_sphere, *args, **kwargs)

class simple_sphere(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos','color','size','trail_color'], oType='simple_sphere', factory=js_simple_sphere, *args, **kwargs)

class box(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos','color','size','axis'], oType='box', factory=js_box, *args, **kwargs)

class cylinder(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'axis', 'color','size'], oType='cylinder', factory=js_cylinder, *args, **kwargs)

class arrow(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'axis', 'color'], oType='arrow', factory=js_arrow, *args, **kwargs)

class cone(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'axis', 'color','size'], oType='cone', factory=js_cone, *args, **kwargs)

class helix(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'axis', 'color','size'], oType='helix', factory=js_helix, *args, **kwargs)

class label(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'color'], oType='label', factory=js_label, *args, **kwargs)

class ellipsoid(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'color', 'axis', 'size'], oType='ellipsoid', factory=js_ellipsoid, *args, **kwargs)

class pyramid(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'color', 'axis', 'size'], oType='pyramid', factory=js_pyramid, *args, **kwargs)

class ring(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'color', 'axis', 'size'], oType='ring', factory=js_ring, *args, **kwargs)

class text(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'color', 'axis'], oType='text', factory=js_text, *args, **kwargs)

class button(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, funcAttrs=['bind'], vecAttrs=['textcolor','background'], oType='button', factory=js_button, *args, **kwargs)

class slider(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, funcAttrs=['bind'], oType='slider', factory=js_slider, *args, **kwargs)

class radio(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, funcAttrs=['bind'], oType='radio', factory=js_radio, *args, **kwargs)

class checkbox(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, funcAttrs=['bind'], oType='checkbox', factory=js_checkbox, *args, **kwargs)

class menu(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, funcAttrs=['bind'], listAttrs=['choices'], oType='menu', factory=js_menu, *args, **kwargs)

class wtext(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, oType='wtext', factory=js_wtext, *args, **kwargs)

class distant_light(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['color','direction'], oType='distant_light', factory=js_distant_light, *args, **kwargs)

class local_light(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['color','pos'], oType='local_light', factory=js_local_light, *args, **kwargs)

class vertex(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos','color','normal','texpos'], oType='vertex', factory=js_vertex, *args, **kwargs)

class extrusion(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, vecAttrs=['pos', 'axis', 'up', 'color', 'start_face_color','end_face_color'], nestAttrs=['shape','path'], oType='extrusion', factory=js_extrusion, *args, **kwargs)

class graph(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, oType='graph', listAttrs=['data','pos'], factory=js_graph, *args, **kwargs)

class graphPlotter(glowProxy):
    def __init__(self, *args, **kwargs):
        glowProxy.__init__(self, *args, **kwargs)

    def plot(self, *args, **kwargs):
        # GlowScript's plot() accepts plot(x, y), plot([x, y]),
        # plot([[x, y], ...]), plot(data=[...]) or plot(pos=[...]). Bare numbers
        # auto-convert to JS, and the data/pos kwargs are converted below, but a
        # Python list/tuple passed positionally arrives as an opaque PyProxy that
        # GlowScript rejects ("A quantity to plot must be an ordinary number").
        # Convert positional sequences to JS arrays.
        args = tuple(to_js(a) if isinstance(a, (list, tuple)) else a for a in args)
        kwargs = translate_kwargs_lists(kwargs, self.listAttrs)
        self.jsObj.plot(*args, **kwargs)

class gcurve(graphPlotter):
    def __init__(self, *args, **kwargs):
        graphPlotter.__init__(self, oType='gcurve', vecAttrs=['color','marker_color','dot_color'], listAttrs=['data','pos'], factory=js_gcurve, *args, **kwargs)

class gvbars(graphPlotter):
    def __init__(self, *args, **kwargs):
        graphPlotter.__init__(self, oType='gvbars', vecAttrs=['color','marker_color'], listAttrs=['data','pos'], factory=js_gvbars, *args, **kwargs)

class ghbars(graphPlotter):
    def __init__(self, *args, **kwargs):
        graphPlotter.__init__(self, oType='ghbars', vecAttrs=['color','marker_color'], listAttrs=['data','pos'],factory=js_ghbars, *args, **kwargs)

class gdots(graphPlotter):
    def __init__(self, *args, **kwargs):
        graphPlotter.__init__(self, oType='gdots', vecAttrs=['color','marker_color'], listAttrs=['data','pos'],factory=js_gdots, *args, **kwargs)

class triangle(glowProxy):
    def __init__(self, *args, **kwargs):
        if ('v0' in kwargs) and ('v1' in kwargs) and ('v2' in kwargs):
            vDict = {**kwargs, 'v0':kwargs['v0'].jsObj, 'v1':kwargs['v1'].jsObj, 'v2':kwargs['v2'].jsObj}
        elif 'vs' in kwargs:
            vertices = to_js(list(map(lambda v: v.jsObj, kwargs['vs'])))
            if len(vertices) != 3:
                raise Exception("triangleProxy: must have exactly 3 vertices")
            vDict = {**kwargs, 'vs':vertices}
        else:
            raise Exception("triangleProxy: must specify v0, v1, v2 or vs")
        jsObj = js_triangle(**vDict)
        super().__init__(oType='triangle', vecAttrs=['color','v0','v1','v2'], jsObj=jsObj)

class quad(glowProxy):
    def __init__(self, *args, **kwargs):
        if ('v0' in kwargs) and ('v1' in kwargs) and ('v2' in kwargs) and ('v3' in kwargs):
            vDict = {**kwargs,
                'v0':kwargs['v0'].jsObj, 
                'v1':kwargs['v1'].jsObj,
                'v2':kwargs['v2'].jsObj,
                'v3':kwargs['v3'].jsObj}
        elif 'vs' in kwargs:
            vertices = to_js(list(map(lambda v: v.jsObj, kwargs['vs'])))
            del kwargs['vs']
            if len(vertices) != 4:
                raise Exception("quadProxy: must have exactly 4 vertices")
            vDict = {**kwargs, 'vs':vertices}
        else:
            raise Exception("quadProxy: must specify v0, v1, v2, v3 or vs")
        jsObj = js_quad(**vDict)
        glowProxy.__init__(self, oType='quad', vecAttrs=['color'], jsObj=jsObj)

class canvasProxy(glowProxy):
    """
    A proxy for a glowscript scene.
    """
    def __init__(self, *args, jsObj=None, factory=None, **kwargs):
        super().__init__(vecAttrs = ['forward', 'center', 'background', 'ambient','up'], listAttrs=['lights'], oType='canvas', jsObj = jsObj, factory=factory, **kwargs)

    def bind(self, action, py_func):
        self.jsObj.bind(action, event_callback_proxy(py_func))

    @property
    def camera(self):
        return cameraProxy(jsObj=self.jsObj.camera)

    @property
    def mouse(self):
        return mouseProxy(jsObj=self.jsObj.mouse)


class canvas(canvasProxy):
    def __init__(self, *args, **kwargs):
        canvasProxy.__init__(self, factory=js_canvas, *args, **kwargs)

scene = canvas(jsObj=js_scene)

def curveDictToJS(d):
    """
    Convert a curve dict with python vectors to js vectors.
    """
    if 'pos' in d:
        d['pos'] = py2js_vec(d['pos'])
    if 'color' in d:
        d['color'] = py2js_vec(d['color'])
    return d

class curveProxy(glowProxy):
    """
    curves are a bit special because there are so many ways to call the constructor.
    """
    def __init__(self, *args, factory = None, oType = 'curve', **kwargs):
        if not factory:
            factory = js_curve
        std_list, std_kwargs = getStdForm(*args, **kwargs)
        if (len(std_list)) > 0:
            std_list_js = to_js(list(map(lambda d: curveDictToJS(d), std_list)), dict_converter=Object.fromEntries)
            super().__init__(oType=oType, factory = factory, vecAttrs=['color'], **std_kwargs) # doesn't like args + kwargs at the same time?
            self.jsObj.append(std_list_js)
        else:
            super().__init__(oType=oType, factory = factory, vecAttrs=['color'], **std_kwargs)

    def append(self, *args, **kwargs):
        std_list,std_kwargs = getStdForm(*args, **kwargs)
        if (len(std_list)) > 0:
            std_list_js = to_js(list(map(lambda d: curveDictToJS(d), std_list)), dict_converter=Object.fromEntries)
            self.jsObj.append(std_list_js)
        else:
            self.jsObj.append(**std_kwargs)

    def point(self, n):
        pt = self.jsObj.point(n)
        return {'pos':pt.pos, 'color':pt.color, 'radius':pt.radius, 'visible':pt.visible}

class curve(curveProxy):
    def __init__(self, *args, **kwargs):
        curveProxy.__init__(self, *args, oType='curve', factory=js_curve, **kwargs)

class points(curveProxy):
    def __init__(self, *args, **kwargs):
        curveProxy.__init__(self, *args, oType='points', factory=js_points, **kwargs)

class compound(glowProxy):
    def __init__(self, *args, **kwargs):
        if 'jsObj' in kwargs:
            jsObj = kwargs['jsObj']
            del kwargs['jsObj']
            return glowProxy.__init__(self, vecAttrs=['pos','axis','color'], *args, oType='compound', jsObj=jsObj, **kwargs)
        else:
            if len(args) != 1:
                raise Exception("compound: must have exactly 1 unnamed argument")
            if not isinstance(args[0],list) or isinstance(args[0],tuple):
                raise Exception("compound: must be passed a list or tuple of objects")
            newArgs = to_js(list(map(lambda o: o.jsObj, args[0])))
            return glowProxy.__init__(self, vecAttrs=['pos','axis','color'], *(newArgs,) , oType='compound', factory=js_compound, **kwargs)

def attach_light(*args, **kwargs):
    if (len(args) != 1):
        raise Exception("attach_light: must have exactly 1 unnamed argument")
    elif (not isinstance(args[0], glowProxy)):
        raise Exception("attach_light: must have a glowProxy as the unnamed argument")
    return glowProxy(vecAttrs=['offset','color'], oType='attach_light', factory=js_attach_light, *(args[0].jsObj,), **kwargs)

def copy(obj, **kwargs):
    """Duplicate a Web VPython object, like GlowScript's standalone copy().

    Equivalent to obj.clone(...); kwargs override attributes on the copy
    (e.g. copy(ball, pos=vector(1,0,0))).
    """
    if not isinstance(obj, glowProxy):
        raise TypeError("copy() argument must be a Web VPython object")
    return obj.clone(**kwargs)

class cameraProxy(glowProxy):
    def __init__(self, *args, jsObj=None):
        if not jsObj:
            raise Exception("must specify a camera as a jsObj")
        super().__init__(vecAttrs=['pos','axis'], oType='camera', jsObj=jsObj)

class mouseProxy(glowProxy):
    def __init__(self, *args, jsObj=None):
        if not jsObj:
            raise Exception("must specify a mouse as a jsObj")
        super().__init__(vecAttrs=['pos'], oType='mouse', jsObj=jsObj)

    def pick(self):
        picked = self.jsObj.pick()
        if picked is None:
            return None

        index = getattr(picked,gsRegKey,None)
        if index is None:
            return picked # it's not in the registry? Just return the JS object
        
        pyObj = gsRegistry.get(index)
        return pyObj
