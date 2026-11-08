"""Pixel content rectangle shared by decoding and template geometry."""
import math
import cv2


def pixel_rect(rect, width, height):
    if rect is None:
        return 0, 0, int(width), int(height)
    if not isinstance(rect, dict) or set(rect) != {'x', 'y', 'width', 'height'}:
        raise ValueError('content_rect must be {x,y,width,height} in source pixels')
    values = [rect[k] for k in ('x', 'y', 'width', 'height')]
    if not all(isinstance(v, (float, int)) and math.isfinite(v) and int(v) == v for v in values):
        raise ValueError('content_rect coordinates must be finite integers')
    x, y, w, h = map(int, values)
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > width or y+h > height:
        raise ValueError('content_rect must fit inside source bounds')
    return x, y, w, h


def crop(frame, rect=None):
    h, w = frame.shape[:2]
    x, y, cw, ch = pixel_rect(rect, w, h)
    return frame[y:y+ch, x:x+cw]


def gray_frame(frame, proc_res, rect=None):
    return cv2.cvtColor(cv2.resize(crop(frame, rect), proc_res,
                                 interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)


def ffmpeg_filter(proc_res, rect=None, source_res=None):
    prefix = ''
    if rect is not None:
        if source_res is None:
            raise ValueError('source_res required for content crop')
        x, y, w, h = pixel_rect(rect, *source_res)
        prefix = f'crop={w}:{h}:{x}:{y}:exact=1,'
    return prefix + f'scale={proc_res[0]}:{proc_res[1]}:flags=area,format=gray'
