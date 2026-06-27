from .vec_js import vector_js as vector
import colorsys

def list_to_vec(L):
    return vector(L[0], L[1], L[2])

class color(object):
    black = vector(0,0,0)
    white = vector(1,1,1)

    red = vector(1,0,0)
    green = vector(0,1,0)
    blue = vector(0,0,1)

    yellow = vector(1,1,0)
    cyan = vector(0,1,1)
    magenta = vector(1,0,1)

    orange = vector(1,0.6,0)
    purple = vector(0.4,0.2,0.6)

    @classmethod
    def gray(cls,luminance):
      return vector(luminance,luminance,luminance)

    @classmethod
    def rgb_to_hsv(cls,v):
      T = [v.x, v.y, v.z]
      c = colorsys.rgb_to_hsv(*T)
      return list_to_vec(c)

    @classmethod
    def hsv_to_rgb(cls,v):
      T = [v.x, v.y, v.z]
      c = colorsys.hsv_to_rgb(*T)
      return list_to_vec(c)

    @classmethod
    def rgb_to_grayscale(cls,v):
      luminance = 0.21*v.x + 0.71*v.y + 0.07*v.z
      return vector(luminance, luminance, luminance)