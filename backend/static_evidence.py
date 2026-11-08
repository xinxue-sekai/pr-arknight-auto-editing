"""Opt-in strict static evidence. Scalar diffs cannot rule out all local UI changes."""
import math
import numpy as np

DEFAULTS = {
    'strict_static_enabled': False,
    'strict_static_max_diff': 0.22,
    'strict_static_window_mean': 0.1,
    'strict_static_min_seconds': 0.5,
    'strict_static_window_seconds': 0.1,
    'strict_static_max_total_diff': 1.5,
}
RULE_VERSION = 1


def evaluate(start, end, diffs, fps, compare):
    cfg = dict(DEFAULTS)
    cfg.update({k: compare[k] for k in DEFAULTS if k in compare})
    if not isinstance(cfg['strict_static_enabled'], bool):
        raise ValueError('strict_static_enabled must be boolean')
    for key in DEFAULTS:
        if key != 'strict_static_enabled' and (not isinstance(cfg[key], (int,float)) or
                not math.isfinite(cfg[key]) or cfg[key] <= 0):
            raise ValueError(key + ' must be finite and positive')
    result = {'rule_version': RULE_VERSION, 'enabled': cfg['strict_static_enabled'],
              'matched': False, 'parameters': cfg}
    if not cfg['strict_static_enabled']:
        result['reason'] = 'disabled'
        return result
    n = end-start+1
    window = max(2, int(math.ceil(fps*cfg['strict_static_window_seconds'])))
    minimum = max(window+1, int(math.ceil(fps*cfg['strict_static_min_seconds'])))
    result.update(frame_count=n, minimum_frames=minimum, window_diffs=window)
    if n < minimum:
        result['reason'] = 'short_segment'
        return result
    values = np.asarray(diffs[start+1:end+1], dtype=np.float64)
    if len(values) != n-1 or not np.isfinite(values).all() or (values < 0).any():
        result['reason'] = 'invalid_evidence'
        return result
    peak = float(values.max())
    cumulative = float(values.sum())
    window_peak = float(np.convolve(values, np.ones(window)/window, 'valid').max())
    result.update(max_diff=peak, mean_diff=float(values.mean()), total_diff=cumulative,
                  max_window_mean=window_peak)
    result['matched'] = (peak < cfg['strict_static_max_diff'] and
                         window_peak < cfg['strict_static_window_mean'] and
                         cumulative < cfg['strict_static_max_total_diff'])
    result['reason'] = 'strict_static' if result['matched'] else 'activity_or_uncertainty'
    return result
