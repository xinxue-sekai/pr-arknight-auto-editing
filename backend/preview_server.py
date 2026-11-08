"""Persistent OpenCV preview worker. stdin/stdout are UTF-8 NDJSON only."""
import argparse
from collections import OrderedDict
import json
import math
from pathlib import Path
import shutil
import sys
import threading

import cv2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', required=True)
    parser.add_argument('--cache', required=True)
    args = parser.parse_args()
    root = Path(args.cache)
    root.mkdir(parents=True, exist_ok=True)
    condition = threading.Condition()
    pending = OrderedDict()
    latest = {}
    stopped = False
    caches = {}

    def emit(message):
        print(json.dumps(message, ensure_ascii=True), flush=True)

    def receive():
        nonlocal stopped
        try:
            for line in sys.stdin:
                try:
                    msg = json.loads(line)
                    channel = msg['channel']
                    if not isinstance(channel, str) or not channel.isalnum() or len(channel) > 80:
                        continue
                    with condition:
                        latest[channel] = msg.get('requestId')
                        pending[channel] = msg
                        condition.notify()
                except (ValueError, KeyError, TypeError):
                    continue
        finally:
            with condition:
                stopped = True
                condition.notify()

    cap = cv2.VideoCapture(args.video)
    try:
        if not cap.isOpened():
            emit({'type': 'fatal', 'code': 'OPEN_FAILED', 'message':
                  'OpenCV cannot open video (unsupported codec or path). '
                  'Try FFmpeg preparePlayback/ensureProxy; if this OpenCV build cannot '
                  'open Unicode paths, place the proxy in an ASCII-only temporary path.'})
            return
        count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        if not math.isfinite(count) or count < 1:
            emit({'type': 'fatal', 'code': 'FRAME_COUNT', 'message': 'Video has no reliable frame count'})
            return
        count = int(count)
        fps = cap.get(cv2.CAP_PROP_FPS)
        fps = fps if math.isfinite(fps) and fps > 0 else None
        threading.Thread(target=receive, daemon=True).start()
        while True:
            with condition:
                condition.wait_for(lambda: stopped or pending)
                if stopped:
                    break
                channel, msg = pending.popitem(last=False)
            cache = caches.setdefault(channel, OrderedDict())
            if msg.get('op') == 'close':
                for entry in cache.values():
                    Path(entry['path']).unlink(missing_ok=True)
                caches.pop(channel, None)
                with condition:
                    latest.pop(channel, None)
                emit({'type': 'closed', 'channel': channel})
                continue
            frame = msg.get('frame')
            request = msg.get('requestId')
            reply = {'channel': channel, 'requestId': request, 'frame': frame}
            try:
                if type(frame) is not int or frame < 0 or frame >= count:
                    raise ValueError('Frame must be an integer in [0, %d)' % count)
                if frame in cache:
                    result = cache.pop(frame)
                    cache[frame] = result
                else:
                    if not cap.set(cv2.CAP_PROP_POS_FRAMES, frame):
                        raise ValueError('Decoder refused frame seek')
                    ok, image = cap.read()
                    position = cap.get(cv2.CAP_PROP_POS_FRAMES)
                    if not ok or image is None or abs(position - (frame + 1)) > 0.5:
                        raise ValueError('EOF or decoder returned a different frame')
                    # Bound JPEG dimensions as well as entry count.
                    height, width = image.shape[:2]
                    source_width, source_height = width, height
                    ratio = min(1.0, 1280.0 / width, 720.0 / height)
                    if ratio < 1:
                        image = cv2.resize(image, (max(1, round(width * ratio)), max(1, round(height * ratio))))
                    height, width = image.shape[:2]
                    target = root / ('%s_%d.jpg' % (channel, frame))
                    # Avoid cv2.imwrite: Windows OpenCV builds may reject Unicode paths.
                    # Encode in memory and let Python's Unicode-aware filesystem write it.
                    encoded, data = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if not encoded:
                        raise ValueError('JPEG encoding failed')
                    target.write_bytes(data.tobytes())
                    result = {'path': str(target.resolve()), 'width': width, 'height': height,
                              'sourceWidth': source_width, 'sourceHeight': source_height}
                    cache[frame] = result
                    while len(cache) > 6:
                        _, old = cache.popitem(last=False)
                        Path(old['path']).unlink(missing_ok=True)
                reply.update(result, type='frame', fps=fps, totalFrames=count,
                             metadataStatus='estimate', fpsStatus='estimate' if fps else 'unknown')
            except Exception as exc:
                reply.update(type='error', code='FRAME_ERROR', message=str(exc))
            with condition:
                if latest.get(channel) == request and not stopped:
                    emit(reply)
    finally:
        cap.release()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    main()
