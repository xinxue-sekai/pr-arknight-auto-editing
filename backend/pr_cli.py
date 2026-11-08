#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pr_cli.py —— Premiere Pro CEP 插件的 Python 分析后端

设计约束
--------
* 与 CEP 面板通过 stdout 的 NDJSON 通信（每行一个独立 JSON 对象）
* 不起 HTTP 服务、不占端口、不触发防火墙弹窗
* 使用本地兼容快照，自动判定和人工覆盖独立保存
* **stdout 只输出协议数据**，所有诊断信息一律走 stderr

协议
----
    {"type":"progress","stage":"analyze","ratio":0.42,"message":"..."}
    {"type":"result", ...}
    {"type":"error","message":"...","detail":"..."}

子命令
------
    probe      读取视频基本信息（帧率/总帧数/分辨率）
    analyze    模板匹配 + 分段，产出会话文件
    ranges     依据面板上的用户编辑重算保留区间与变速标记
    export-edl 生成 CMX3600 EDL

会话文件由两部分组成：
    <session>.json   段落结构（体积小，可被面板读取回显）
    <session>.<version>.npz    states / diffs 数组（体积大，仅 Python 侧使用）
这样面板调参重算时无需重新解码视频，等价于原 Tkinter 版对
diffs_array 的持久化设计。
"""

import argparse
import io
import json
import os
import sys
import traceback
import time
import static_evidence
from session_store import (save_session, load_session, ProtocolError, SCHEMA_VERSION,
                           source_identity, template_identity, digest,
                           check_recompute, recompute_pause)

# Imports and template paths are anchored to this backend, without changing caller cwd.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import numpy as np  # noqa: E402

import analyzer  # noqa: E402
from frame_types import (FRAME_TYPE_NORMAL, FRAME_TYPE_PAUSE,  # noqa: E402
                         FRAME_TYPE_1X, FRAME_TYPE_2X, FRAME_TYPE_0_2X)

# ------------------------------------------------------------------
#  默认参数（与 settings_panel.py 的初值保持一致）
# ------------------------------------------------------------------

DEFAULT_PARAMS = {
    'proc_res': [400, 225],
    'content_rect': None,
    'template_content_rect': None,
    'batch': 128,
    'threads': min(4, max(1, (os.cpu_count() or 4))),
    'thresholds': {
        'pause': 0.7,
        'speed_1x': 0.7,
        'speed_2x': 0.7,
        'speed_0_2x': 0.7,
    },
    'compare': {
        'still_time_thresh': 0.1,
        'motion_thresh': 2.0,
        'boundary_thresh': 5.0,
        **static_evidence.DEFAULTS,
    },
    'decode_backend': 'opencv',
    'ffmpeg_path': None,
    # Premiere 时间轴无法承载抽帧产生的大量单帧碎片，
    # 变速改由 Marker 提示用户手动设置，故默认关闭抽帧。
    'speedup_1x': False,
    'speedup_02': False,
    'speedup_02_factor': 10,
    # Marker 建议的播放速度百分比
    'suggest_speed': {
        str(FRAME_TYPE_1X): 200.0,
        str(FRAME_TYPE_2X): 100.0,
        str(FRAME_TYPE_0_2X): 500.0,
    },
}

SPEED_LABEL = {
    FRAME_TYPE_1X: '1x',
    FRAME_TYPE_2X: '2x',
    FRAME_TYPE_0_2X: '0.2x',
}


# ------------------------------------------------------------------
#  stdout 协议输出
# ------------------------------------------------------------------

def emit(obj):
    """向面板写一行 JSON。stdout 必须保持 UTF-8，避免中文在 GBK 控制台乱码。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def emit_progress(stage, ratio, message='', **details):
    emit({'type': 'progress', 'stage': stage,
          'ratio': round(float(ratio), 4), 'message': message, **details})


def log(msg):
    """诊断信息走 stderr，不污染协议通道。"""
    sys.stderr.write('[pr_cli] %s\n' % msg)
    sys.stderr.flush()


# ------------------------------------------------------------------
#  参数与会话文件
# ------------------------------------------------------------------

def merge_params(raw):
    """把面板传来的稀疏参数覆盖到默认值上（仅两层深度）。"""
    out = json.loads(json.dumps(DEFAULT_PARAMS))
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def load_params(path_or_inline):
    if not path_or_inline:
        return merge_params(None)
    return merge_params(load_json_arg(path_or_inline))


def load_json_arg(path_or_inline):
    """接受「文件路径」或「内联 JSON 字符串」。

    必须支持文件形式：面板回传的 overrides 含每个暂停段的
    local_del_mask 数组，真实录像有几百段时序列化后可达数百 KB，
    而 Windows 命令行长度上限只有约 32KB，内联传参会被静默截断。
    """
    if not path_or_inline:
        return {}
    text = path_or_inline
    if os.path.isfile(path_or_inline):
        with io.open(path_or_inline, 'r', encoding='utf-8') as f:
            text = f.read()
    data = json.loads(text)
    return data if isinstance(data, dict) else {}


def npz_path(session_path):
    return os.path.splitext(session_path)[0] + '.npz'


# ------------------------------------------------------------------
#  序列化 / 反序列化
# ------------------------------------------------------------------

def seg_to_json(seg):
    """pause / speed / clip 段落转 JSON 安全结构。"""
    out = {}
    for k, v in seg.items():
        if isinstance(v, np.ndarray):
            out[k] = v.tolist()
        elif isinstance(v, (np.integer,)):
            out[k] = int(v)
        elif isinstance(v, (np.floating,)):
            out[k] = float(v)
        else:
            out[k] = v
    return out


def seg_from_json(seg):
    """面板回传的段落还原成 analyzer 需要的类型。"""
    out = dict(seg)
    if 'local_del_mask' in out and out['local_del_mask'] is not None:
        out['local_del_mask'] = np.asarray(out['local_del_mask'])
    for k in ('id', 'start', 'end', 'type', 'keep_in', 'keep_out'):
        if k in out and out[k] is not None:
            if isinstance(out[k], bool) or not isinstance(out[k], (int, float)) or not np.isfinite(out[k]) or int(out[k]) != out[k]:
                raise ProtocolError('INVALID_OVERRIDE', 'Segment coordinates must be integers')
            out[k] = int(out[k])
    if out.get('boundary_diff') is not None:
        out['boundary_diff'] = float(out['boundary_diff'])
    return out


# ------------------------------------------------------------------
#  视频探测
# ------------------------------------------------------------------

def probe_video(video_path):
    import cv2
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError('无法打开视频文件: %s' % video_path)
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        cap.release()
    if fps <= 0:
        fps = 30.0
    return {'fps': fps, 'total_frames': total,
            'width': width, 'height': height}


def resolve_proc_res(params, probe):
    """处理分辨率：高度为默认 225 时按源素材宽高比自适应（同 preview_player）。"""
    pw, ph = int(params['proc_res'][0]), int(params['proc_res'][1])
    w, h = probe.get('width', 0), probe.get('height', 0)
    if params.get('content_rect') is not None:
        _, _, w, h = analyzer.pixel_rect(params['content_rect'], w, h)
    if ph == 225 and w > 0 and h > 0:
        ph = max(1, int(round(pw * h / float(w))))
    return (pw, ph)


# ------------------------------------------------------------------
#  clip 段构建（移植自 preview_player._build_clip_segments）
# ------------------------------------------------------------------

def build_clip_segments(pauses, total_frames):
    """暂停段之外的区间即为 clip 段，供面板拖拽 keep_in/keep_out 微调。"""
    if total_frames <= 0:
        return []
    occupied = sorted([(int(s['start']), int(s['end'])) for s in pauses])
    clips = []
    clip_id = 0
    prev_end = -1
    for ps, pe in occupied:
        gap_start, gap_end = prev_end + 1, ps - 1
        if gap_end >= gap_start:
            clips.append({'id': clip_id, 'start': gap_start, 'end': gap_end,
                          'keep_in': gap_start, 'keep_out': gap_end})
            clip_id += 1
        prev_end = pe
    tail_start, tail_end = prev_end + 1, total_frames - 1
    if tail_end >= tail_start:
        clips.append({'id': clip_id, 'start': tail_start, 'end': tail_end,
                      'keep_in': tail_start, 'keep_out': tail_end})
    return clips


# ------------------------------------------------------------------
#  保留区间 + 变速标记
# ------------------------------------------------------------------

def compute_keep_ranges(states, pauses, speeds, clips, params):
    """调用 analyzer.build_delete_set，但**强制关闭抽帧变速**。

    抽帧会把一个 600 帧的 1x 区间打散成 300 个单帧保留区。这在 FFmpeg
    顺序写帧时无所谓，但落到 Premiere 时间轴上就是 300 个一帧长的碎片
    clip，完全不可用。变速统一交给 Marker 提示 + 用户手动设置。
    """
    total = len(states)
    to_del = analyzer.build_delete_set(
        total, states, pauses, speeds, clips,
        speedup_1x=False, speedup_02=False, speedup_02_factor=1)
    return analyzer._kept_frame_ranges(to_del), to_del


def build_record_index(keep_ranges, total):
    """源帧号 → 时间轴(record)帧号 的映射，-1 表示该源帧已被删除。"""
    rec = np.full(total, -1, dtype=np.int64)
    pos = 0
    for s, e in keep_ranges:
        n = int(e) - int(s)
        if n <= 0:
            continue
        rec[int(s):int(e)] = np.arange(pos, pos + n, dtype=np.int64)
        pos += n
    return rec, pos


def build_markers(speeds, keep_ranges, total, params):
    """为变速区间生成序列标记。

    标记位置用 **record 时间**（时间轴时间），因为 Marker 挂在序列上。
    若某变速区间的起始帧被删掉了，就落到该区间内第一个被保留的帧上。
    """
    if total <= 0:
        return []
    rec, _ = build_record_index(keep_ranges, total)
    suggest = params.get('suggest_speed', {}) or {}

    markers = []
    for seg in speeds:
        t = int(seg.get('type', FRAME_TYPE_NORMAL))
        if t not in SPEED_LABEL:
            continue
        s, e = int(seg['start']), int(seg['end'])
        s = max(0, min(s, total - 1))
        e = max(s, min(e, total - 1))

        window = rec[s:e + 1]
        kept = np.nonzero(window >= 0)[0]
        if kept.size == 0:
            continue  # 整段都被删了，无需提示

        rec_start = int(window[kept[0]])
        rec_end = int(window[kept[-1]])
        percent = float(suggest.get(str(t), 100.0))
        label = SPEED_LABEL[t]

        markers.append({
            'record_start': rec_start,
            'record_end': rec_end,
            'source_start': int(s + kept[0]),
            'source_end': int(s + kept[-1]),
            'frame_type': t,
            'label': label,
            'percent': percent,
            'name': '变速 %s → %g%%' % (label, percent),
            'comment': '游戏 %s 倍速区间（源帧 %d-%d）。'
                       '选中此片段，右键→速度/持续时间，设为 %g%%。'
                       % (label, int(s + kept[0]), int(s + kept[-1]), percent),
        })
        if t == FRAME_TYPE_0_2X:
            markers[-1].update(requires_review=True,
                uncertainty_reason='transition_template_false_positive',
                name='疑似 ' + markers[-1]['name'],
                comment='疑似 0.2x：模板匹配可能将过场误识别为慢速；请核对画面后再调整速度。'
                        + markers[-1]['comment'])
    markers.sort(key=lambda m: m['record_start'])
    return markers


# ------------------------------------------------------------------
#  EDL 导出（CMX3600）
# ------------------------------------------------------------------

def _tc(frame, fps):
    """帧号 → HH:MM:SS:FF。fps 取整，非整帧率素材用四舍五入近似。"""
    fps_i = max(1, int(round(fps)))
    frame = max(0, int(frame))
    f = frame % fps_i
    total_sec = frame // fps_i
    s = total_sec % 60
    m = (total_sec // 60) % 60
    h = total_sec // 3600
    return '%02d:%02d:%02d:%02d' % (h, m, s, f)


def build_edl(keep_ranges, fps, clip_name, reel='AX', title='ARKNIGHT AUTO EDIT'):
    """生成 CMX3600 EDL 文本。

    reel 用 AX（文件型素材惯例），并附带 * FROM CLIP NAME 注释，
    Premiere 依据它把 EDL 事件重链到实际媒体文件。
    record 时码从 00:00:00:00 起连续累加，等价于 ripple 拼接。
    """
    lines = ['TITLE: %s' % title, 'FCM: NON-DROP FRAME', '']
    rec_pos = 0
    for i, (s, e) in enumerate(keep_ranges, start=1):
        n = int(e) - int(s)
        if n <= 0:
            continue
        lines.append('%03d  %-8s V     C        %s %s %s %s' % (
            i, reel,
            _tc(s, fps), _tc(int(s) + n, fps),
            _tc(rec_pos, fps), _tc(rec_pos + n, fps)))
        lines.append('* FROM CLIP NAME: %s' % clip_name)
        lines.append('')
        rec_pos += n
    return '\n'.join(lines), rec_pos


# ------------------------------------------------------------------
#  子命令实现
# ------------------------------------------------------------------

def cmd_suggest_content_rect(args):
    from content_suggestion import suggest
    emit({'type':'result', 'suggestion':suggest(args.video)})


def cmd_migrate_session(args):
    from session_store import migrate_session
    session = migrate_session(args.session, args.session_out, BASE_DIR)
    emit({'type':'result', 'session':session, 'session_path':os.path.abspath(args.session_out)})


def cmd_health(args):
    params = load_params(args.params)
    started = time.perf_counter()
    configs, loaded = analyzer.load_templates(tuple(params['proc_res']), params.get('template_content_rect'))
    counts = {key: len(configs[key]) for key in analyzer.TEMPLATE_DIRS}
    emit({'type': 'result', 'health': {'ok': all(counts.values()),
          'schema_version': SCHEMA_VERSION,
 'python': sys.version.split()[0],
          'numpy': np.__version__, 'opencv': analyzer.cv2.__version__,
          'cv2_threads': analyzer.cv2.getNumThreads(),
          'default_workers': DEFAULT_PARAMS['threads'], 'templates_loaded': loaded,
          'template_counts': counts, 'templates_seconds': time.perf_counter()-started}})


def cmd_probe(args):
    info = probe_video(args.video)
    info.update({
        'video_path': os.path.abspath(args.video),
        'exists': True,
        'analyzer_dir': BASE_DIR,
        'templates_loaded': _count_templates(args),
    })
    emit({'type': 'result', 'probe': info})


def _count_templates(args):
    params = load_params(args.params if hasattr(args, 'params') else None)
    proc_res = (int(params['proc_res'][0]), int(params['proc_res'][1]))
    try:
        _, n = analyzer.load_templates(proc_res, params.get('template_content_rect'))
        return int(n)
    except Exception as exc:
        log('模板加载失败: %s' % exc)
        return 0


def cmd_analyze(args):
    started = time.perf_counter()
    params = load_params(args.params)
    probe = probe_video(args.video)
    fps = probe['fps']
    proc_res = resolve_proc_res(params, probe)
    log('proc_res=%s fps=%s total=%s' % (proc_res, fps, probe['total_frames']))

    emit_progress('templates', 0.0, '加载模板')
    configs, loaded = analyzer.load_templates(proc_res, params.get('template_content_rect'))
    template_seconds = time.perf_counter() - started
    if loaded == 0 or any(not configs[k] for k in analyzer.TEMPLATE_DIRS):
        raise RuntimeError(
            '未找到可用模板。请确认 %s 下的 templates_*/ 与 source_images_*/ '
            '目录包含匹配的截图。' % BASE_DIR)
    emit_progress('templates', 0.05, '已加载 %d 个模板' % loaded, stage_ratio=1.0)

    backend = params.get('decode_backend') or 'opencv'
    try:
        backend = analyzer.normalize_decode_backend(backend)
    except ValueError as exc:
        log('解码后端无效，回退 OpenCV: %s' % exc)
        backend = 'opencv'

    def prog(r):
        emit_progress('analyze', 0.05 + float(r) * 0.75, '模板匹配中', stage_ratio=float(r))
    prog.details = lambda r, **details: emit_progress('analyze', .05+float(r)*.75,
        '模板匹配中', stage_ratio=float(r), **details)

    score_batches = []
    decode_started = time.perf_counter()
    states, diffs, context = analyzer.analyze_video_with_context(
        args.video, configs, params['thresholds'], proc_res,
        int(params['batch']), int(params['threads']), prog,
        decode_backend=backend, ffmpeg_path=params.get('ffmpeg_path'),
        content_rect=params.get('content_rect'), score_sink=score_batches)

    decode_seconds = time.perf_counter() - decode_started
    total = len(states)
    if total <= 0:
        raise RuntimeError('未能解码出任何帧')

    def prog2(r):
        emit_progress('segments', 0.8 + float(r) * 0.19, '分段中', stage_ratio=float(r))

    segment_started = time.perf_counter()
    pauses, speeds = analyzer.build_segments(
        states, diffs, args.video, proc_res, params['compare'], fps, prog2,
        analysis_context=context, content_rect=params.get('content_rect'))
    for seg in pauses:
        seg['mode'] = 'auto'
        recompute_pause(seg, diffs, fps, params['compare'])
    segment_seconds = time.perf_counter() - segment_started
    clips = build_clip_segments(pauses, total)

    used_ctx = analyzer.analysis_context_skips_second_scan(context, pauses, total)
    log('context complete=%s L=%d skip_second_scan=%s'
        % (context.get('complete') if isinstance(context, dict) else None,
           total, used_ctx))

    keep_ranges, _ = compute_keep_ranges(states, pauses, speeds, clips, params)
    markers = build_markers(speeds, keep_ranges, total, params)

    session = {
        'schema_version': SCHEMA_VERSION,
        'content_rect': params.get('content_rect'),
        'analysis_context': context,
        'score_cache': {'version': analyzer.SCORE_CACHE_VERSION,
            'classes': list(analyzer.SCORE_CLASSES), 'dtype': 'float64'},
        'template_manifest': analyzer.template_manifest(configs),
        'analysis_provenance': {'params': params, 'source': source_identity(args.video),
            'templates_sha256': template_identity(BASE_DIR),
            'analyzer_sha256': digest(os.path.join(BASE_DIR, 'analyzer.py')),
            'geometry_sha256': digest(os.path.join(BASE_DIR, 'geometry.py')),
            'resolved_proc_res': list(proc_res), 'decode_backend': backend},
        'stage_stats': {'templates_seconds': template_seconds,
            'decode_classify_seconds': decode_seconds, 'segments_seconds': segment_seconds,
            'total_seconds': time.perf_counter()-started,
            'decoded_frames': total, 'workers': min(int(params['threads']), os.cpu_count() or 1)},
        'video_path': os.path.abspath(args.video),
        'fps': fps,
        'total_frames': total,
        'proc_res': list(proc_res),
        'decode_backend': backend,
        'context_complete': bool(used_ctx),
        'params': params,
        'pause_segments': [seg_to_json(s) for s in pauses],
        'speed_segments': [seg_to_json(s) for s in speeds],
        'clip_segments': [seg_to_json(s) for s in clips],
        'keep_ranges': [[int(a), int(b)] for a, b in keep_ranges],
        'markers': markers,
        'stats': _stats(keep_ranges, total, fps),
    }
    save_session(args.session_out, session, {'states': states, 'diffs': diffs,
        'scores': np.concatenate(score_batches, axis=0)})

    emit_progress('done', 1.0, '分析完成')
    emit({'type': 'result', 'session': session})


def _stats(keep_ranges, total, fps):
    kept = sum(int(e) - int(s) for s, e in keep_ranges)
    removed = max(0, int(total) - kept)
    return {
        'kept_frames': int(kept),
        'removed_frames': int(removed),
        'kept_seconds': round(kept / fps, 2) if fps else 0.0,
        'removed_seconds': round(removed / fps, 2) if fps else 0.0,
        'ratio': round(kept / float(total), 4) if total else 0.0,
        'segment_count': len(keep_ranges),
    }


def cmd_ranges(args):
    """面板调参 / 拖拽后重算，无需重新解码视频。"""
    started = time.perf_counter()
    session, data = load_session(args.session)
    override_params = load_json_arg(args.session_params) if args.session_params else None
    params = merge_params(session.get('params'))
    for key, value in (override_params or {}).items():
        if isinstance(value, dict) and isinstance(params.get(key), dict):
            params[key].update(value)
        else:
            params[key] = value
    check_recompute(session, params, BASE_DIR, data)
    states = data['states']
    diffs = data['diffs']
    total = len(states)

    overrides = load_json_arg(args.overrides)
    pauses = [seg_from_json(s) for s in
              overrides.get('pause_segments', session['pause_segments'])]
    speeds = [seg_from_json(s) for s in
              overrides.get('speed_segments', session['speed_segments'])]
    clips = [seg_from_json(s) for s in
             overrides.get('clip_segments', session['clip_segments'])]

    # Overrides may change decisions/handles, never segmentation or identity.
    for key, segments in (('pause_segments', pauses), ('speed_segments', speeds), ('clip_segments', clips)):
        original = session[key]
        identities = [(s['id'], s['start'], s['end']) for s in segments]
        expected = [(s['id'], s['start'], s['end']) for s in original]
        if sorted(identities) != sorted(expected) or len(set(identities)) != len(identities):
            raise ProtocolError('INVALID_OVERRIDE', 'Segment identity or bounds changed')
    for clip in clips:
        if not (clip['start'] <= clip['keep_in'] <= clip['end'] + 1 and
                clip['start'] - 1 <= clip['keep_out'] <= clip['end']):
            raise ProtocolError('INVALID_OVERRIDE', 'Clip handles outside segment')

    # Always rerun the full automatic rule; keep/all are solely user overrides.
    previous = {int(s['id']): s for s in session['pause_segments']}
    for seg in pauses:
        prior = previous.get(int(seg['id']))
        if prior is None or (seg['start'], seg['end']) != (prior['start'], prior['end']):
            raise ProtocolError('REANALYZE_REQUIRED', 'Pause segmentation changed')
        seg['boundary_diff'] = prior.get('boundary_diff')
        restoring = prior.get('mode') != 'auto' and seg.get('mode') == 'auto'
        recompute_pause(seg, diffs, session['fps'], params['compare'],
                        reset_manual=restoring)

    # Refresh persisted manual edits from the current frontend representation.
    # This also permits restoring auto after a previous threshold reclassification.
    if 'manual_frame_mask' in data:
        manual = data['manual_frame_mask'].copy()
        for seg in pauses:
            start, end = seg['start'], seg['end']
            mask = np.asarray(seg['local_del_mask'])
            manual[start:end+1] = (3 if seg['mode'] == 'keep' else 2 if seg['mode'] == 'all'
                else np.where((mask == 2) | (mask == 3), mask, 0))
        data['manual_frame_mask'] = manual
    if params['thresholds'] != session['params']['thresholds']:
        from reclassify import rebuild
        states, pauses, speeds = rebuild(session, data, params, pauses, clips)
        clips = build_clip_segments(pauses, total)
    manual = data.get('manual_frame_mask')
    keep_ranges, deletion = compute_keep_ranges(states, pauses, speeds, clips, params)
    if manual is not None:
        deletion[manual == 2] = True
        deletion[manual == 3] = False
        # Current clip trims take precedence over decisions carried from old pauses.
        _, clip_deletion = compute_keep_ranges(states, [], [], clips, params)
        deletion |= clip_deletion
        keep_ranges = analyzer._kept_frame_ranges(deletion)

    markers = build_markers(speeds, keep_ranges, total, params)

    session['pause_segments'] = [seg_to_json(s) for s in pauses]
    session['clip_segments'] = [seg_to_json(s) for s in clips]
    session['speed_segments'] = [seg_to_json(s) for s in speeds]
    session['keep_ranges'] = [[int(a), int(b)] for a, b in keep_ranges]
    session['markers'] = markers
    session['stats'] = _stats(keep_ranges, total, session['fps'])
    session['params'] = params
    session['range_provenance'] = {'static_rule_version': static_evidence.RULE_VERSION,
        'static_rule_sha256': digest(os.path.join(BASE_DIR, 'static_evidence.py')),
        'compare': params['compare']}
    session.setdefault('stage_stats', {})['ranges_seconds'] = round(time.perf_counter()-started, 6)
    data['states'] = states
    save_session(args.session, session, data)

    emit({'type': 'result', 'session': session})


def cmd_export_edl(args):
    session, _ = load_session(args.session)
    overrides = load_json_arg(args.overrides)
    ranges = overrides.get('keep_ranges') or session['keep_ranges']
    ranges = [(int(a), int(b)) for a, b in ranges]
    if not ranges:
        raise RuntimeError('没有可导出的保留区间')

    clip_name = args.clip_name or os.path.basename(session['video_path'])
    text, rec_total = build_edl(
        ranges, session['fps'], clip_name,
        reel=args.reel or 'AX', title=args.title or 'ARKNIGHT AUTO EDIT')

    out = args.out
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)

    emit({'type': 'result', 'edl_path': os.path.abspath(out),
          'events': len(ranges),
          'record_frames': int(rec_total),
          'record_seconds': round(rec_total / session['fps'], 2)
          if session.get('fps') else 0.0})


# ------------------------------------------------------------------
#  入口
# ------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog='pr_cli.py',
        description='明日方舟自动剪辑 —— Premiere Pro CEP 插件分析后端')
    sub = p.add_subparsers(dest='command')

    def add_common(sp):
        sp.add_argument('--params', default=None,
                        help='参数 JSON 文件路径，或直接内联 JSON 字符串')

    sp = sub.add_parser('suggest-content-rect', help='仅建议内容矩形，不自动应用')
    sp.add_argument('--video', required=True)
    sp.set_defaults(func=cmd_suggest_content_rect)
    sp = sub.add_parser('migrate-session', help='显式复制兼容旧会话，保留原始来源')
    sp.add_argument('--session', required=True)
    sp.add_argument('--session-out', required=True)
    sp.set_defaults(func=cmd_migrate_session)

    sp = sub.add_parser('health', help='检查运行环境及各类模板实际加载')
    add_common(sp)
    sp.set_defaults(func=cmd_health)

    sp = sub.add_parser('probe', help='读取视频基本信息')
    sp.add_argument('--video', required=True)
    add_common(sp)
    sp.set_defaults(func=cmd_probe)

    sp = sub.add_parser('analyze', help='模板匹配 + 分段')
    sp.add_argument('--video', required=True)
    sp.add_argument('--session-out', required=True,
                    help='会话 JSON 输出路径（同名 .npz 保存 states/diffs）')
    add_common(sp)
    sp.set_defaults(func=cmd_analyze)

    sp = sub.add_parser('ranges', help='依据用户编辑重算保留区间与标记')
    sp.add_argument('--session', required=True)
    sp.add_argument('--overrides', default=None,
                    help='JSON 文件路径或内联 JSON：面板上被用户修改过的段落')
    sp.add_argument('--session-params', default=None,
                    help='JSON 文件路径或内联 JSON：面板最新参数（覆盖会话内参数）')
    sp.set_defaults(func=cmd_ranges)

    sp = sub.add_parser('export-edl', help='生成 CMX3600 EDL')
    sp.add_argument('--session', required=True)
    sp.add_argument('--out', required=True)
    sp.add_argument('--overrides', default=None)
    sp.add_argument('--clip-name', default=None)
    sp.add_argument('--reel', default='AX')
    sp.add_argument('--title', default='ARKNIGHT AUTO EDIT')
    sp.set_defaults(func=cmd_export_edl)

    return p


def main(argv=None):
    # Windows 下 ProcessPoolExecutor 用 spawn，打包成 exe 时必须调用
    import multiprocessing
    multiprocessing.freeze_support()

    # 强制 UTF-8，避免中文在 Windows GBK 控制台变成乱码
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, 'func', None):
        parser.print_help(sys.stderr)
        return 2

    try:
        args.func(args)
        return 0
    except Exception as exc:
        log(traceback.format_exc())
        emit({'type': 'error',
              'code': getattr(exc, 'code', 'BACKEND_ERROR'),
              'message': '%s: %s' % (type(exc).__name__, exc),
              'detail': traceback.format_exc()})
        return 1


if __name__ == '__main__':
    sys.exit(main())
