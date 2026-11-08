"""Rebuild segmentation from cached scores with sparse boundary reads."""
import numpy as np
import analyzer
from session_store import ProtocolError, recompute_pause


def rebuild(session, data, params, pauses, clips):
    if any(c['keep_in'] != c['start'] or c['keep_out'] != c['end'] for c in clips):
        raise ProtocolError('CLIP_EDITS_RESET_REQUIRED', 'Restore clip handles before threshold reclassification')
    cache = session.get('score_cache', {})
    scores = data.get('scores')
    if (cache.get('version') != analyzer.SCORE_CACHE_VERSION or
        cache.get('classes') != list(analyzer.SCORE_CLASSES) or scores is None or
        scores.shape != (session['total_frames'], 4)):
        raise ProtocolError('REANALYZE_REQUIRED', 'No compatible per-class score cache')
    states = analyzer.classify_scores(scores, params['thresholds'])
    # A changed decode path must never supply boundary values for a different pipeline.
    # OpenCV sparse seeks are supported; FFmpeg reclassification can reuse exact runs,
    # otherwise explicitly asks for boundary acquisition rather than scanning the video.
    old_context = session.get('analysis_context')
    old_runs = {(p['start'], p['end']): p for p in session['pause_segments']}
    starts = np.flatnonzero((states == 1) & np.r_[True, states[:-1] != 1])
    ends = np.flatnonzero((states == 1) & np.r_[states[1:] != 1, True])
    records = []
    complete = True
    for start, end in zip(starts, ends):
        old = old_runs.get((int(start), int(end)))
        if old is None or old.get('boundary_diff') is None:
            complete = False
            break
        records.append(dict(start=int(start), end=int(end), before_index=max(0,int(start)-1),
                            after_index=min(len(states)-1,int(end)+1), diff=old['boundary_diff']))
    context = analyzer._make_analysis_context(len(states), records, complete)
    boundary_reader = None
    if not complete and session.get('decode_backend') != 'opencv':
        from sparse_ffmpeg import read_frames
        boundary_reader = lambda indices: read_frames(session['video_path'], indices,
            tuple(session['proc_res']), params.get('content_rect'), params.get('ffmpeg_path'))
    new_pauses, speeds = analyzer.build_segments(states, data['diffs'], session['video_path'],
        tuple(session['proc_res']), params['compare'], session['fps'],
        analysis_context=context, content_rect=params.get('content_rect'), boundary_reader=boundary_reader)
    # Transfer manual decisions by source-frame position across split/merged segments.
    manual = np.asarray(data.get('manual_frame_mask', np.zeros(len(states))), dtype=np.uint8).copy()
    for p in pauses:
        start, end = p['start'], p['end']
        m = np.asarray(p['local_del_mask'])
        if p['mode'] in ('keep', 'all'):
            manual[start:end+1] = 3 if p['mode'] == 'keep' else 2
        else:
            manual[start:end+1] = np.where((m == 2) | (m == 3), m, 0)
    for p in new_pauses:
        m = manual[p['start']:p['end']+1]
        p['local_del_mask'][m != 0] = m[m != 0]
        recompute_pause(p, data['diffs'], session['fps'], params['compare'])
    context = analyzer._make_analysis_context(len(states), [dict(start=p['start'], end=p['end'],
        before_index=max(0,p['start']-1), after_index=min(len(states)-1,p['end']+1),
        diff=p['boundary_diff']) for p in new_pauses], True)
    session['analysis_context'] = context
    session['classification_provenance'] = {'score_cache_version': cache['version'],
        'thresholds': dict(params['thresholds']), 'boundary_method': 'cached' if complete else 'ffmpeg_sparse_seek' if boundary_reader else 'opencv_sparse_seek'}
    data['states'] = states
    data['manual_frame_mask'] = manual
    return states, new_pauses, speeds
