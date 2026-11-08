"""Versioned session commits: immutable arrays, JSON commit pointer published last."""
import hashlib
import json
import os
from pathlib import Path
import uuid
import numpy as np
import re
from session_lock import session_lock
import static_evidence

SCHEMA_VERSION = 2


class ProtocolError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save_session(path, payload, arrays):
    with session_lock(path):
        return _save_session(path, payload, arrays)


def _save_session(path, payload, arrays):
    path = Path(path)
    previous = None
    if path.exists():
        with open(path, encoding='utf-8') as f:
            current = json.load(f)
        if payload.get('arrays_version') != current.get('arrays_version'):
            raise ProtocolError('SESSION_CONFLICT', 'Session changed; reload before saving')
        previous = current.get('arrays_file')
    version = uuid.uuid4().hex
    target = path.with_name(path.stem + '.' + version + '.npz')
    tmp = path.with_name(path.name + '.' + version + '.tmp')
    updated = dict(payload, schema_version=SCHEMA_VERSION, arrays_version=version,
                   arrays_file=target.name)
    try:
        with open(target, 'xb') as f:
            np.savez_compressed(f, **arrays, arrays_version=np.array(version))
            f.flush()
            os.fsync(f.fileno())
        updated['arrays_sha256'] = digest(target)
        with open(tmp, 'x', encoding='utf-8') as f:
            json.dump(updated, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise
    payload.update(updated)
    # Readers hold this same lock until arrays are copied into memory.
    for candidate in path.parent.glob(path.stem + '.*.npz'):
        suffix = candidate.name[len(path.stem)+1:-4]
        if re.fullmatch('[0-9a-f]{32}', suffix) and candidate.name not in (target.name, previous):
            try:
                candidate.unlink()
            except OSError:
                pass  # Retry on next successful commit (e.g. external process holding file).


def load_session(path):
    with session_lock(path):
        return _load_session(path)


def _load_session(path):
    path = Path(path)
    with open(path, encoding='utf-8') as f:
        payload = json.load(f)
    version = payload.get('schema_version', 1)
    if version not in (1, SCHEMA_VERSION):
        raise ProtocolError('UNSUPPORTED_SCHEMA', 'Unsupported session schema')
    if version == SCHEMA_VERSION:
        name = payload['arrays_file']
        if Path(name).name != name or '/' in name or '\\' in name:
            raise ProtocolError('INVALID_SESSION', 'Unsafe arrays_file')
        arrays_path = path.parent / name
        if digest(arrays_path) != payload['arrays_sha256']:
            raise ProtocolError('INVALID_SESSION', 'Array checksum mismatch')
    else:
        arrays_path = path.with_suffix('.npz')
        payload['migration'] = 'legacy_modes_preserved_as_manual; provenance_unknown'
    with np.load(arrays_path, allow_pickle=False) as data:
        arrays = {k: data[k].copy() for k in data.files}
    if version == SCHEMA_VERSION and str(arrays.get('arrays_version')) != payload['arrays_version']:
        raise ProtocolError('INVALID_SESSION', 'Array generation mismatch')
    arrays.pop('arrays_version', None)
    n = payload['total_frames']
    if arrays['states'].shape != (n,) or arrays['diffs'].shape != (n,):
        raise ProtocolError('INVALID_SESSION', 'Array length mismatch')
    return payload, arrays


def source_identity(path):
    stat = os.stat(path)
    return {'path': os.path.normcase(os.path.abspath(path)), 'size': stat.st_size,
            'mtime_ns': stat.st_mtime_ns}


def template_identity(base):
    root = Path(base)
    files = sorted(p for pattern in ('templates_*/*', 'source_images_*/*')
                   for p in root.glob(pattern) if p.is_file())
    return hashlib.sha256(json.dumps([(p.relative_to(root).as_posix(), digest(p))
                                     for p in files]).encode()).hexdigest()


# Audited baseline: score/decode geometry and priority are unchanged by progress,
# Unicode path loading and sparse-boundary additions. Opt-in migration is required.
COMPATIBLE_ANALYZERS = {'a259e3808de3d8668f0c1b49137455e216041a1b04c3fe7c568f95b2a8d2dd02'}
BASELINE_GEOMETRY = '6f98e4fc8f86568d46250a2517994723e9ca524f6f35cdf2ac6e3cbc325f42cb'


def compatible_analyzer(session, base):
    original = session['analysis_provenance']['analyzer_sha256']
    current = digest(Path(base) / 'analyzer.py')
    if original == current:
        return True
    migration = session.get('compatibility_migration', {})
    return (original in COMPATIBLE_ANALYZERS and migration.get('from_analyzer_sha256') == original
            and migration.get('to_analyzer_sha256') == current
            and migration.get('geometry_sha256') == digest(Path(base) / 'geometry.py') == BASELINE_GEOMETRY)


def migrate_session(source, target, base):
    if Path(source).resolve() == Path(target).resolve() or Path(target).exists():
        raise ProtocolError('INVALID_MIGRATION', 'Migration requires a new output path')
    payload, arrays = load_session(source)
    original = payload.get('analysis_provenance', {}).get('analyzer_sha256')
    if original not in COMPATIBLE_ANALYZERS or digest(Path(base) / 'geometry.py') != BASELINE_GEOMETRY:
        raise ProtocolError('REANALYZE_REQUIRED', 'No audited compatibility for this implementation')
    payload['compatibility_migration'] = dict(from_analyzer_sha256=original,
        to_analyzer_sha256=digest(Path(base) / 'analyzer.py'), geometry_sha256=BASELINE_GEOMETRY,
        source_session_sha256=digest(source), policy='score-geometry-v1-explicit-copy')
    check_recompute(payload, payload['params'], base, arrays)
    save_session(target, payload, arrays)
    return payload


def check_recompute(session, params, base, arrays=None):
    old = session.get('params', {})
    # Only these parameters can be recomputed from states/diffs; all unknowns fail closed.
    allowed = {'compare', 'suggest_speed', 'speedup_1x', 'speedup_02', 'speedup_02_factor',
               'batch', 'threads'}
    if (arrays is not None and 'scores' in arrays and session.get('score_cache', {}).get('version') == 1
            and session.get('analysis_provenance')):
        allowed.add('thresholds')
    old = dict(old)
    old.setdefault('content_rect', None)
    old.setdefault('template_content_rect', None)
    changed = [k for k in set(old) | set(params) if old.get(k) != params.get(k) and k not in allowed]
    if changed:
        raise ProtocolError('REANALYZE_REQUIRED', 'Analysis parameters changed: ' + ', '.join(sorted(changed)))
    known_compare = {'still_time_thresh', 'motion_thresh', 'boundary_thresh'} | set(static_evidence.DEFAULTS)
    if any(old.get('compare', {}).get(k) != params.get('compare', {}).get(k)
           for k in set(old.get('compare', {})) | set(params.get('compare', {}))
           if k not in known_compare):
        raise ProtocolError('REANALYZE_REQUIRED', 'Unknown comparison parameter changed')
    provenance = session.get('analysis_provenance')
    if provenance:
        try:
            valid = (provenance['source'] == source_identity(session['video_path']) and
                     provenance['templates_sha256'] == template_identity(base) and
                     compatible_analyzer(session, base))
        except OSError:
            valid = False
        if valid and provenance.get('geometry_sha256'):
            valid = provenance['geometry_sha256'] == digest(Path(base) / 'geometry.py')
        if not valid:
            raise ProtocolError('REANALYZE_REQUIRED', 'Source, analyzer or templates changed')
    # Legacy provenance remains unknown; never manufacture an analysis origin.


def recompute_pause(seg, diffs, fps, compare, reset_manual=False):
    import analyzer
    start, end = int(seg['start']), int(seg['end'])
    if not 0 <= start <= end < len(diffs):
        raise ProtocolError('INVALID_OVERRIDE', 'Pause bounds outside analyzed frames')
    mode = seg.get('mode', 'auto')
    if mode not in ('auto', 'keep', 'all'):
        raise ProtocolError('INVALID_OVERRIDE', 'Unknown pause mode')
    old = np.asarray(seg.get('local_del_mask', np.zeros(end-start+1)))
    if old.shape != (end-start+1,) or not np.isin(old, [0, 1, 2, 3]).all():
        raise ProtocolError('INVALID_OVERRIDE', 'Invalid pause mask')
    mask, auto_mode = analyzer._analyze_pause_mask(start, end, diffs,
        max(2, int(fps * compare['still_time_thresh'])), compare['motion_thresh'])
    reason = 'motion_stillness'
    boundary = seg.get('boundary_diff')
    if boundary is not None and np.isfinite(boundary) and float(boundary) < compare['boundary_thresh']:
        auto_mode, reason = 'all', 'boundary_unchanged'
        mask[:] = 1
    evidence = static_evidence.evaluate(start, end, diffs, fps, compare)
    seg['static_evidence'] = evidence
    if evidence['matched']:
        auto_mode, reason = 'all', 'strict_static'
        mask[:] = 1
    if not reset_manual:
        manual = (old == 2) | (old == 3)
        mask[manual] = old[manual]
    seg.update(mode=mode, auto_mode=auto_mode, auto_reason=reason, local_del_mask=mask)
    return seg
