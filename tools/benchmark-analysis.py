"""Serial, isolated short-clip benchmark of the adjacent legacy analyzer.
Run with python -I -B benchmark-analysis.py. Writes only the requested output tree.
"""
import argparse
import csv
import ctypes
from ctypes import wintypes as w
import hashlib
import importlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test_footage/performance_20261108'
LEGACY = ROOT / 'arknight-auto-editing-main'
SOURCE = Path('D:/OBSStudio/2026-07-09 16-22-50.mp4')
START, COUNT = 18000, 1800


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def memory_tree(pid):
    # PrivateUsage = private committed bytes; WorkingSetSize includes shared pages.
    class Entry(ctypes.Structure):
        _fields_ = [('size', w.DWORD), ('usage', w.DWORD), ('pid', w.DWORD),
                    ('heap', ctypes.c_size_t), ('module', w.DWORD), ('threads', w.DWORD),
                    ('parent', w.DWORD), ('priority', w.LONG), ('flags', w.DWORD),
                    ('exe', w.WCHAR * 260)]
    class Mem(ctypes.Structure):
        _fields_ = [('cb', w.DWORD), ('faults', w.DWORD)] + [(n, ctypes.c_size_t) for n in
            ('peak_ws', 'ws', 'peak_paged', 'paged', 'peak_nonpaged', 'nonpaged', 'pagefile', 'peak_pagefile', 'private')]
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    p = ctypes.WinDLL('psapi', use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = w.HANDLE
    k.OpenProcess.restype = w.HANDLE
    k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    k.CloseHandle.argtypes = [w.HANDLE]
    k.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    k.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    p.GetProcessMemoryInfo.argtypes = [w.HANDLE, ctypes.POINTER(Mem), w.DWORD]
    snap = k.CreateToolhelp32Snapshot(2, 0)
    e = Entry(); e.size = ctypes.sizeof(e)
    parents = {}
    ok = k.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        parents[e.pid] = e.parent
        ok = k.Process32NextW(snap, ctypes.byref(e))
    k.CloseHandle(snap)
    ids = {pid}
    while True:
        expanded = ids | {i for i, parent in parents.items() if parent in ids}
        if expanded == ids:
            break
        ids = expanded
    private = working = measured = 0
    for i in ids:
        h = k.OpenProcess(0x410, False, i)
        if h:
            m = Mem(); m.cb = ctypes.sizeof(m)
            if p.GetProcessMemoryInfo(h, ctypes.byref(m), m.cb):
                private += m.private; working += m.ws; measured += 1
            k.CloseHandle(h)
    return private, working, measured


def child(args):
    begin = time.perf_counter()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(LEGACY))  # Explicit trusted project, never footage directory.
    a = importlib.import_module('analyzer')
    import numpy as np
    import cv2
    imported = time.perf_counter()
    for dirs in a.TEMPLATE_DIRS.values():
        for key in dirs:
            dirs[key] = str(LEGACY / dirs[key])
    res = (400, 250)  # Original 16:10 aspect ratio; matches previous baseline.
    configs, templates = a.load_templates(res)
    assert templates > 0
    loaded = time.perf_counter()
    clip = str(OUT / 'clip-18000-19800.mp4')
    states, diffs, context = a.analyze_video_with_context(
        clip, configs, {k: .7 for k in configs}, res, 128, args.workers,
        decode_backend=args.backend, ffmpeg_path='ffmpeg')
    analyzed = time.perf_counter()
    pauses, speeds = a.build_segments(states, diffs, clip, res,
        {'still_time_thresh': .1, 'motion_thresh': 2, 'boundary_thresh': 5}, 60,
        analysis_context=context)
    segmented = time.perf_counter()
    deleted = a.build_delete_set(len(states), states, pauses, speeds, [], False, False, 1)
    ranges = np.asarray(a._kept_frame_ranges(deleted), dtype='<i8').reshape(-1, 2)
    finished = time.perf_counter()
    arrays = {'states': states, 'diffs': diffs, 'ranges': ranges}
    hashes = {key + '_sha256': hashlib.sha256(x.dtype.str.encode() + str(x.shape).encode() + x.tobytes()).hexdigest()
              for key, x in arrays.items()}
    np.savez(OUT / (args.run_id + '.npz'), **arrays)
    result = dict(run_id=args.run_id, backend=args.backend, workers=args.workers, batch=128,
        frames=len(states), kept_frames=int((~deleted).sum()), range_count=len(ranges),
        templates=templates, proc_res=list(res), context_complete=context.get('complete'),
        context_skips_scan=a.analysis_context_skips_second_scan(context, pauses, len(states)),
        import_s=imported-begin, templates_s=loaded-imported, analysis_s=analyzed-loaded,
        segments_s=segmented-analyzed, ranges_s=finished-segmented,
        pipeline_s=finished-loaded, numpy=np.__version__, opencv=cv2.__version__, **hashes)
    save(OUT / (args.run_id + '.json'), result)


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    clip = OUT / 'clip-18000-19800.mp4'
    if (OUT / 'mapping.json').exists():
        return
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_streams', '-of', 'json', str(SOURCE)]))
    cmd = ['ffmpeg', '-nostdin', '-y', '-v', 'error', '-threads', '4', '-i', str(SOURCE),
        '-an', '-vf', f'trim=start_frame={START}:end_frame={START+COUNT},setpts=PTS-STARTPTS',
        '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0',
        '-threads', '4', '-pix_fmt', 'yuvj444p', str(clip)]
    started = time.perf_counter()
    subprocess.run(cmd, check=True)
    # Independent sequential original decode establishes exact global frame mapping.
    hashes = []
    for name, video, filt in [('source', SOURCE, f'trim=start_frame={START}:end_frame={START+COUNT},setpts=PTS-STARTPTS'),
                              ('clip', clip, 'setpts=PTS-STARTPTS')]:
        dest = OUT / (name + '.framemd5')
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', '-threads', '4', '-i', str(video),
            '-an', '-vf', filt, '-fps_mode', 'passthrough', '-pix_fmt', 'yuvj444p',
            '-f', 'framemd5', str(dest)], check=True)
        hashes.append([line.split(',')[-1].strip() for line in dest.read_text().splitlines()
                       if line and not line.startswith('#')])
    assert len(hashes[0]) == COUNT and hashes[0] == hashes[1], 'Lossless frame mapping failed'
    save(OUT / 'mapping.json', dict(source=str(SOURCE), source_stat_size=SOURCE.stat().st_size,
        source_stat_mtime_ns=SOURCE.stat().st_mtime_ns, source_probe=probe,
        source_frame_start=START, source_frame_end_exclusive=START+COUNT,
        clip_frames=COUNT, mapping='source_frame = clip_frame + 18000 (zero based)',
        fps=60, frame_md5_all_equal=True, clip_sha256=sha(clip), command=cmd,
        preparation_and_verification_s=time.perf_counter()-started))


def summarize(rows):
    import numpy as np
    reference = np.load(OUT / (rows[0]['run_id'] + '.npz'), allow_pickle=False)
    for row in rows:
        with np.load(OUT / (row['run_id'] + '.npz'), allow_pickle=False) as data:
            row['states_mismatch_vs_opencv1'] = int(np.count_nonzero(data['states'] != reference['states']))
            row['diffs_max_abs_vs_opencv1'] = float(np.max(np.abs(data['diffs']-reference['diffs'])))
            row['ranges_equal_vs_opencv1'] = bool(np.array_equal(data['ranges'], reference['ranges']))
    groups = []
    for backend in ('opencv', 'ffmpeg_sw_passthrough'):
        for workers in (1, 4, 8):
            subset = [r for r in rows if r['backend'] == backend and r['workers'] == workers]
            if not subset:
                continue
            groups.append(dict(backend=backend, workers=workers, runs=len(subset),
                median_wall_s=statistics.median(r['wall_s'] for r in subset),
                median_analysis_s=statistics.median(r['analysis_s'] for r in subset),
                min_wall_s=min(r['wall_s'] for r in subset), max_wall_s=max(r['wall_s'] for r in subset),
                peak_private_mib=max(r['peak_private_bytes'] for r in subset)/2**20,
                peak_working_set_mib=max(r['peak_working_set_bytes'] for r in subset)/2**20,
                repeat_exact=all(len({r[k] for r in subset}) == 1 for k in ('states_sha256','diffs_sha256','ranges_sha256','frames')),
                reference_states_equal=all(r['states_mismatch_vs_opencv1'] == 0 for r in subset),
                reference_ranges_equal=all(r['ranges_equal_vs_opencv1'] for r in subset)))
    save(OUT / 'results.json', dict(runs=rows, summary=groups,
        notes=['Wall includes interpreter, imports, templates, analysis, ranges and artifact writes.',
               'Memory: maximum sampled simultaneous sum over child process tree, 100ms interval; shared working-set pages may be counted more than once; brief peaks can be missed.',
               'Pipeline uses analysis context; speedup disabled; clip boundaries reset previous-frame state.',
               'Lossless transcode preserves pixels, but codec/GOP differ from original; no full-video extrapolation.',
               'Fixed legacy analyzer; no new/backend code modified or benchmarked.']))
    with (OUT / 'results.csv').open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    save(OUT / 'summary.json', groups)
    eligible = [g for g in groups if g['runs'] == 3 and g['repeat_exact']
                and g['reference_states_equal'] and g['reference_ranges_equal']]
    if eligible:
        best = min(eligible, key=lambda g: g['median_wall_s'])
        text = (f"Fastest reliable configuration on this clip: {best['backend']}, workers={best['workers']}, batch=128.\n"
                f"Median wall: {best['median_wall_s']:.3f}s; peak sampled private commit: {best['peak_private_mib']:.1f} MiB.\n"
                "Reliability here means three identical repeats, 1800 decoded frames, and states/kept ranges equal to OpenCV workers=1.\n"
                "Cross-backend diffs are not necessarily bit-identical: consult results.csv for maximum absolute differences.\n"
                "Source frames [18000,19800), lossless transcode verified by all 1800 frame MD5s; no 26-minute analysis was run.\n"
                "Only this 30-second segment was tested; it does not establish full-video accuracy or original-codec performance.\n")
    else:
        text = 'No configuration met all repeatability and reference-output checks. Inspect results.json.\n'
    (OUT / 'conclusion.txt').write_text(text, encoding='utf-8')
    print(json.dumps(groups, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--child', action='store_true')
    parser.add_argument('--backend', default='opencv')
    parser.add_argument('--workers', type=int, default=1)
    parser.add_argument('--run-id', default='probe')
    args = parser.parse_args()
    if args.child:
        child(args); return
    prepare()
    save(OUT / 'environment.json', dict(python=sys.version, executable=sys.executable,
        platform=platform.platform(), cpu_count=os.cpu_count(), analyzer_sha256=sha(LEGACY/'analyzer.py'),
        frame_types_sha256=sha(LEGACY/'frame_types.py'), ffmpeg=subprocess.check_output(['ffmpeg','-version'], text=True).splitlines()[0],
        template_hashes={str(p.relative_to(LEGACY)): sha(p) for pattern in ('templates_*/*','source_images_*/*')
                         for p in LEGACY.glob(pattern) if p.is_file()}))
    rows = []
    configs = [(b, w) for b in ('opencv','ffmpeg_sw_passthrough') for w in (1,4,8)]
    for repeat in range(1,4):
        # Rotate order across rounds to reduce fixed ordering bias; all runs serial.
        order = configs[2*(repeat-1):] + configs[:2*(repeat-1)]
        for backend, workers in order:
            run_id = f'{backend}-w{workers}-r{repeat}'
            print('START ' + run_id, flush=True)
            started = time.perf_counter()
            with (OUT/(run_id+'.log')).open('w', encoding='utf-8') as log:
                proc = subprocess.Popen([sys.executable, '-I', '-B', str(Path(__file__).resolve()),
                    '--child', '--backend', backend, '--workers', str(workers), '--run-id', run_id],
                    cwd=str(Path(__file__).parent), stdout=log, stderr=subprocess.STDOUT)
                peak_private = peak_ws = peak_count = samples = 0
                while proc.poll() is None:
                    private, ws, count = memory_tree(proc.pid)
                    peak_private = max(private, peak_private); peak_ws = max(ws, peak_ws)
                    peak_count = max(count, peak_count); samples += 1
                    time.sleep(.1)
                if proc.returncode:
                    raise RuntimeError(f'{run_id} failed: see log')
            row = json.loads((OUT/(run_id+'.json')).read_text(encoding='utf-8'))
            row.update(wall_s=time.perf_counter()-started, peak_private_bytes=peak_private,
                       peak_working_set_bytes=peak_ws, peak_process_count=peak_count, memory_samples=samples)
            assert row['frames'] == COUNT
            rows.append(row)
            save(OUT/'runs-in-progress.json', rows)
            print(f"DONE {run_id} wall={row['wall_s']:.3f}s private={peak_private/2**20:.1f}MiB", flush=True)
    summarize(rows)


if __name__ == '__main__':
    main()
