try:
   from .vector import vector
except:
   from vector import vector # maybe we're not in a module? for debugging.

"""
Helper functions for the curve constructor/append methods.

Lots of different options/patterns need to be supported. The idea here is to transform all the
different methods into a standart form that can be easily transformed to JS objects.

All these forms will be converted into a list of dictionaries plus a dictionary of global attributes.

   1) c = curve(v1,v2)
   2) c = curve([v1,v2])
   3) c = curve(pos=[v1,v2])
   4) c = curve(v1)
      c.append(v2)

   5) c = curve()
      c.append(v1,v2)

   Specifying overall color and radius

   1) c = curve(pos=[v1,v2], color=color.cyan, radius=0.3)
   2) c = curve(color=color.cyan, radius=0.3)
      c.append(v1,v2)

      p1 = dict(pos=v1, color=color.red,  radius=0.1)
      p2 = dict(pos=v2, color=color.blue, radius=.3)
      curve(p1,p2)

      p1 = {'pos':v1, 'color':color.red,  'radius':0.1}
      p2 = {'pos':v2, 'color':color.blue, 'radius':0.3}
      curve(p1,p2)

      c = curve(retain=150)
      c.append( pos=vector(2,-1,0), retain=30)
"""

def fill_in_defaults(default, listOfDicts):
   return list(map(lambda item: {**default, **item}, listOfDicts))

def convert_list_of_vectors_to_dicts(vs, allow_dicts = True):
   """
   make sure lists are convterted to standard form. To run tests: `python -m doctest -v curveArgs.py`

   >>> convert_list_of_vectors_to_dicts([vector(1,2,3), vector(4,5,6)])
   [{'pos': <1, 2, 3>}, {'pos': <4, 5, 6>}]

   >>> convert_list_of_vectors_to_dicts([{'pos':vector(1,2,3)},{'pos':vector(4,5,6)}])
   [{'pos': <1, 2, 3>}, {'pos': <4, 5, 6>}]

   >>> convert_list_of_vectors_to_dicts([vector(1,2,3), {'pos':vector(4,5,6)}])
   [{'pos': <1, 2, 3>}, {'pos': <4, 5, 6>}]

   >>> convert_list_of_vectors_to_dicts([vector(1,2,3), {'pos':vector(4,5,6), 'color':vector(1,2,3)}])
   [{'pos': <1, 2, 3>}, {'pos': <4, 5, 6>, 'color': <1, 2, 3>}]

   >>> convert_list_of_vectors_to_dicts([vector(1,2,3), {'pos':vector(4,5,6), 'color':vector(1,2,3), 'radius':0.2}])
   [{'pos': <1, 2, 3>}, {'pos': <4, 5, 6>, 'color': <1, 2, 3>, 'radius': 0.2}]
   """
   result = []
   if isinstance(vs, list) or isinstance(vs, tuple):
      for v in vs:
         if isinstance(v, vector):
            result.append({'pos':v})
         elif allow_dicts and isinstance(v, dict):
            dvec = v.get('pos', None)
            if isinstance(dvec, vector):
               result.append(v)
            elif isinstance(dvec, list) or isinstance(dvec, tuple):
               result += convert_list_of_vectors_to_dicts(dvec, allow_dicts=False) # really needs to be a list of vecs only
            else:
               raise Exception('pos key of dictionary must be a vector or a list of vectors',dvec)
            cvec = v.get('color', None)
            if cvec:
               if not isinstance(cvec, vector):
                  raise Exception('color key of dictionary must be a vector', cvec)
         elif isinstance(v,list) or isinstance(v,tuple):
            result += convert_list_of_vectors_to_dicts(v)
         else:
            raise Exception('list must contain vectors or dictionaries with a pos key',v)

   return result

def getStdForm(*args, **kwargs):
   """
   Assume args has one element that's a list of vectors of dicts, or args *is* a list of vectors or dicts.
   returns an updated args list with kwargs as a default dictionary.

   >>> getStdForm(vector(1,2,3),vector(3,4,5))
   [{'pos': <1, 2, 3>}, {'pos': <3, 4, 5>}]

   >>> getStdForm(vector(1,2,3),vector(3,4,5), color=vector(1,2,2))
   [{'color': <1, 2, 2>, 'pos': <1, 2, 3>}, {'color': <1, 2, 2>, 'pos': <3, 4, 5>}]

   >>> getStdForm({'pos':[vector(1,2,3),vector(3,4,5)]}, color=vector(1,2,2))
   [{'color': <1, 2, 2>, 'pos': <1, 2, 3>}, {'color': <1, 2, 2>, 'pos': <3, 4, 5>}]

   """
   std_form = convert_list_of_vectors_to_dicts(args)
   if len(std_form) == 0:
      """
      we must have only a dictionary of global attributes, and possibly one position.
      """
      pos = kwargs.get('pos', None)
      if pos:
         del kwargs['pos']
         if isinstance(pos, vector):
            std_form.append({'pos':pos})
         elif isinstance(pos, list) or isinstance(pos, tuple):
            std_form = convert_list_of_vectors_to_dicts(pos)
         else:
            raise Exception('pos must be a vector or list of vectors, or dicts')
      
   return fill_in_defaults(kwargs, std_form), kwargs

