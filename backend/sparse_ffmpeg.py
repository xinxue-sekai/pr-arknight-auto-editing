"""Bounded timestamp seeks for CFR sources; reject ambiguous frame identity."""
import json
import os
import re
import shutil
import subprocess
from fractions import Fraction
import numpy as np
import analyzer
from geometry import ffmpeg_filter
from session_store import ProtocolError


def read_frames(video, indices, proc_res, content_rect=None, ffmpeg_path=None):
    try:
        return _read_frames(video, indices, proc_res, content_rect, ffmpeg_path)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError) as exc:
        raise ProtocolError('BOUNDARY_READ_REQUIRED', 'Sparse FFmpeg boundary read failed: ' + str(exc)) from exc


def _read_frames(video, indices, proc_res, content_rect=None, ffmpeg_path=None):
    ffmpeg = analyzer.resolve_ffmpeg_path(ffmpeg_path)
    sibling = os.path.join(os.path.dirname(ffmpeg), 'ffprobe.exe' if os.name == 'nt' else 'ffprobe')
    ffprobe = sibling if os.path.isfile(sibling) else shutil.which('ffprobe')
    if not ffprobe:
        raise ProtocolError('BOUNDARY_READ_REQUIRED', 'ffprobe is required to verify sparse frame timestamps')
    info = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,start_time',
        '-of', 'json', video], capture_output=True, check=True, timeout=30)
    stream = json.loads(info.stdout)['streams'][0]
    rate = Fraction(stream['r_frame_rate'])
    if rate <= 0 or rate != Fraction(stream['avg_frame_rate']):
        raise ProtocolError('BOUNDARY_READ_REQUIRED', 'Variable/ambiguous frame rate requires an indexed timestamp cache')
    origin = float(stream.get('start_time', 0))
    frames = {}
    filters = ffmpeg_filter(proc_res, content_rect, (stream['width'], stream['height']))
    for index in sorted(set(indices)):
        # Seek slightly before target; output bounded to a few frames. showinfo verifies
        # absolute source PTS, and consecutive ticks must match the expected CFR grid.
        target = index / float(rate) + origin
        seek = max(0., index / float(rate) - 2 / float(rate))
        cmd = [ffmpeg, '-hide_banner', '-loglevel', 'info', '-nostdin', '-copyts',
            '-ss', f'{seek:.12f}', '-i', video, '-map', '0:v:0', '-an',
            '-frames:v', '5', '-vf', filters + ',showinfo', '-fps_mode', 'passthrough',
            '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']
        result = subprocess.run(cmd, capture_output=True, timeout=45,
            creationflags=analyzer._NO_WINDOW)
        log = result.stderr.decode('utf-8', errors='replace')
        time_bases = re.findall(r'config in time_base:\s*(\d+/\d+)', log)
        ticks = re.findall(r'\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:', log)
        if not time_bases or Fraction(time_bases[-1]) <= 0:
            raise ProtocolError('BOUNDARY_READ_REQUIRED', 'Missing exact boundary time base')
        # pts_time is printed with limited precision; integer PTS remains exact even
        # many hours into the recording. Never infer identity from rounded text.
        time_base = Fraction(time_bases[-1])
        pts = [float(int(tick) * time_base) for tick in ticks]
        size = proc_res[0] * proc_res[1]
        count, remainder = divmod(len(result.stdout), size)
        if result.returncode or remainder or count == 0 or len(pts) < count:
            raise ProtocolError('BOUNDARY_READ_REQUIRED', f'Cannot decode verified boundary frame {index}')
        pts = pts[:count]  # showinfo may log a look-ahead frame past output limit
        tolerance = max(1e-5, .01 / float(rate))
        matches = [i for i, value in enumerate(pts) if abs(value-target) < tolerance]
        grid_ok = all(abs((b-a)-1/float(rate)) < tolerance*2 for a,b in zip(pts,pts[1:]))
        if len(matches) != 1 or not grid_ok:
            raise ProtocolError('BOUNDARY_READ_REQUIRED', f'Ambiguous timestamp for boundary frame {index}')
        offset = matches[0]*size
        frames[index] = np.frombuffer(result.stdout[offset:offset+size], np.uint8).reshape(proc_res[1],proc_res[0]).copy()
    return frames
