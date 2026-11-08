import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pr_cli as cli
import analyzer
import session_store as store


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'session.json'
        self.params = cli.merge_params(None)
        self.seg = dict(id=0, start=0, end=9, mode='auto', boundary_diff=0,
                        local_del_mask=[0, 2, 3, 0, 0, 0, 0, 0, 0, 0])
        self.arrays = dict(states=np.ones(10, dtype=np.int8), diffs=np.zeros(10))
        self.session = dict(total_frames=10, fps=30, params=self.params,
                            pause_segments=[self.seg], speed_segments=[], clip_segments=[],
                            keep_ranges=[[0, 10]], video_path='legacy.mp4')

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        p = subprocess.run([sys.executable, str(Path(cli.__file__)), *map(str, args)],
                           capture_output=True, text=True, encoding='utf-8')
        messages = [json.loads(line) for line in p.stdout.splitlines()]
        return p.returncode, messages

    def test_boundary_and_manual_mask(self):
        store.recompute_pause(self.seg, self.arrays['diffs'], 30, self.params['compare'])
        self.assertEqual(self.seg['mode'], 'auto')
        self.assertEqual(self.seg['auto_mode'], 'all')
        self.assertEqual(self.seg['auto_reason'], 'boundary_unchanged')
        self.assertEqual(self.seg['local_del_mask'].tolist(), [1, 2, 3, 1, 1, 1, 1, 1, 1, 1])
        ranges, _ = cli.compute_keep_ranges(self.arrays['states'], [self.seg], [], [], self.params)
        self.assertEqual(ranges, [(2, 3)])
        self.seg['boundary_diff'] = 5
        store.recompute_pause(self.seg, self.arrays['diffs'], 30, self.params['compare'])
        self.assertEqual(self.seg['auto_mode'], 'auto')
        self.assertEqual(self.seg['local_del_mask'][2], 3)
        self.assertEqual(self.seg['local_del_mask'][0], 0)

    def test_restore_auto_full_rules(self):
        self.seg['mode'] = 'keep'
        store.save_session(self.path, self.session, self.arrays)
        override = dict(self.seg, mode='auto')
        rc, messages = self.run_cli('ranges', '--session', self.path, '--overrides',
                                   json.dumps({'pause_segments': [override]}))
        self.assertEqual(rc, 0, messages)
        result = messages[-1]['session']
        self.assertEqual(result['keep_ranges'], [])
        self.assertEqual(result['pause_segments'][0]['local_del_mask'], [1]*10)

    def test_sparse_params_preserve_manual(self):
        store.save_session(self.path, self.session, self.arrays)
        rc, messages = self.run_cli('ranges', '--session', self.path, '--session-params',
                                   '{"compare":{"boundary_thresh":0}}')
        self.assertEqual(rc, 0, messages)
        result = messages[-1]['session']
        self.assertEqual(result['pause_segments'][0]['local_del_mask'][1:3], [2, 3])
        self.assertEqual(result['params']['compare']['motion_thresh'], 2)

    def test_analysis_and_unknown_changes_fail_without_write(self):
        store.save_session(self.path, self.session, self.arrays)
        before = self.path.read_bytes()
        for raw in ['{"thresholds":{"pause":0.9}}', '{"new_algorithm":true}',
                    '{"compare":{"unknown":1}}', '{"proc_res":[200,100]}']:
            rc, messages = self.run_cli('ranges', '--session', self.path, '--session-params', raw)
            self.assertEqual(rc, 1)
            self.assertEqual(messages[-1]['code'], 'REANALYZE_REQUIRED')
            self.assertEqual(self.path.read_bytes(), before)

    def test_atomic_failure_keeps_old_pair(self):
        store.save_session(self.path, self.session, self.arrays)
        before = self.path.read_bytes()
        with patch.object(store.os, 'replace', side_effect=OSError('injected interruption')):
            with self.assertRaises(OSError):
                store.save_session(self.path, self.session, dict(states=np.zeros(10), diffs=np.zeros(10)))
        self.assertEqual(self.path.read_bytes(), before)
        _, arrays = store.load_session(self.path)
        self.assertTrue((arrays['states'] == 1).all())
        self.assertEqual(len(list(self.path.parent.glob('*.npz'))), 1)

    def test_corrupt_arrays_rejected(self):
        store.save_session(self.path, self.session, self.arrays)
        (self.path.parent / self.session['arrays_file']).write_bytes(b'bad')
        with self.assertRaisesRegex(store.ProtocolError, 'checksum'):
            store.load_session(self.path)

    def test_legacy_conservative_migration(self):
        self.seg['mode'] = 'all'
        self.path.write_text(json.dumps(self.session), encoding='utf-8')
        np.savez(self.path.with_suffix('.npz'), **self.arrays)
        rc, messages = self.run_cli('ranges', '--session', self.path)
        self.assertEqual(rc, 0, messages)
        result = messages[-1]['session']
        self.assertEqual(result['schema_version'], 2)
        self.assertEqual(result['pause_segments'][0]['mode'], 'all')
        self.assertEqual(result['keep_ranges'], [])
        self.assertNotIn('analysis_provenance', result)
        self.assertIn('provenance_unknown', result['migration'])

    def test_provenance_invalidated(self):
        source = self.path.parent / 'video.bin'
        source.write_bytes(b'original')
        self.session['video_path'] = str(source)
        self.session['analysis_provenance'] = dict(source=store.source_identity(source),
            templates_sha256=store.template_identity(cli.BASE_DIR),
            analyzer_sha256=store.digest(Path(cli.BASE_DIR) / 'analyzer.py'))
        store.check_recompute(self.session, self.params, cli.BASE_DIR)
        source.write_bytes(b'changed source')
        with self.assertRaisesRegex(store.ProtocolError, 'changed'):
            store.check_recompute(self.session, self.params, cli.BASE_DIR)

    def test_health_actual_loading_and_ndjson(self):
        rc, messages = self.run_cli('health')
        self.assertEqual(rc, 0, messages)
        health = messages[-1]['health']
        configs, count = analyzer.load_templates()
        self.assertEqual(health['template_counts'], {k: len(v) for k, v in configs.items()})
        self.assertEqual(health['templates_loaded'], count)
        self.assertTrue(health['ok'])
        self.assertLessEqual(health['default_workers'], 4)
        self.assertEqual(health['cv2_threads'], 1)

    def test_health_rejects_missing_template_class(self):
        from types import SimpleNamespace
        configs = {k: [object()] for k in analyzer.TEMPLATE_DIRS}
        configs['speed_0_2x'] = []
        with patch.object(analyzer, 'load_templates', return_value=(configs, 3)), \
             patch.object(cli, 'emit') as output:
            cli.cmd_health(SimpleNamespace(params=None))
        health = output.call_args.args[0]['health']
        self.assertFalse(health['ok'])
        self.assertEqual(health['template_counts']['speed_0_2x'], 0)

    def test_segments_keep_automatic_decision_separate(self):
        context = analyzer._make_analysis_context(10, [dict(start=0, end=9,
            before_index=0, after_index=9, diff=0)], True)
        pauses, _ = analyzer.build_segments(self.arrays['states'], self.arrays['diffs'],
            'unused', (400, 225), self.params['compare'], 30, analysis_context=context)
        self.assertEqual(pauses[0]['mode'], 'auto')
        self.assertEqual(pauses[0]['auto_mode'], 'all')
        self.assertEqual(pauses[0]['local_del_mask'].tolist(), [1]*10)

    def test_invalid_mask_rejected(self):
        self.seg['local_del_mask'] = [2]
        with self.assertRaises(store.ProtocolError):
            store.recompute_pause(self.seg, self.arrays['diffs'], 30, self.params['compare'])

    def test_fractional_mask_rejected_without_commit(self):
        store.save_session(self.path, self.session, self.arrays)
        before = self.path.read_bytes()
        override = dict(self.seg, local_del_mask=[2.5] * 10)
        rc, messages = self.run_cli('ranges', '--session', self.path, '--overrides',
                                   json.dumps({'pause_segments': [override]}))
        self.assertEqual(rc, 1, messages)
        self.assertEqual(messages[-1]['code'], 'INVALID_OVERRIDE')
        self.assertEqual(self.path.read_bytes(), before)

    def test_clip_trim_wins_over_carried_manual_keep(self):
        self.session.update(pause_segments=[], clip_segments=[dict(
            id=0, start=0, end=9, keep_in=0, keep_out=9)])
        self.arrays['states'][:] = 0
        self.arrays['manual_frame_mask'] = np.full(10, 3, dtype=np.uint8)
        store.save_session(self.path, self.session, self.arrays)
        clips = [dict(id=0, start=0, end=9, keep_in=2, keep_out=7)]
        rc, messages = self.run_cli('ranges', '--session', self.path, '--overrides',
                                   json.dumps({'clip_segments': clips}))
        self.assertEqual(rc, 0, messages)
        result = messages[-1]['session']
        self.assertEqual(result['keep_ranges'], [[2, 8]])
        self.assertEqual(result, json.loads(self.path.read_text(encoding='utf-8')))
        loaded, _ = store.load_session(self.path)
        self.assertEqual(result, loaded)

    def test_invalid_clip_bounds_rejected_without_commit(self):
        self.session.update(pause_segments=[], clip_segments=[dict(
            id=0, start=0, end=9, keep_in=0, keep_out=9)])
        store.save_session(self.path, self.session, self.arrays)
        before = self.path.read_bytes()
        for clip in [dict(id=0, start=0, end=9, keep_in=-1, keep_out=9),
                     dict(id=0, start=0, end=8, keep_in=0, keep_out=8)]:
            rc, messages = self.run_cli('ranges', '--session', self.path, '--overrides',
                                       json.dumps({'clip_segments': [clip]}))
            self.assertEqual(rc, 1, messages)
            self.assertEqual(messages[-1]['code'], 'INVALID_OVERRIDE')
            self.assertEqual(self.path.read_bytes(), before)

    def test_unknown_compare_removal_rejected(self):
        import copy
        self.session['params']['compare']['future_rule'] = 1
        params = copy.deepcopy(self.params)
        del params['compare']['future_rule']
        with self.assertRaises(store.ProtocolError):
            store.check_recompute(self.session, params, cli.BASE_DIR)

    def test_slow_marker_exposes_transition_uncertainty(self):
        markers = cli.build_markers([dict(start=0, end=9, type=4)], [(0, 10)], 10, self.params)
        self.assertTrue(markers[0]['requires_review'])
        self.assertIn('过场', markers[0]['comment'])
        self.assertNotIn('confidence', markers[0])

    def test_read_exact_partial_chunks(self):
        class Stream:
            def __init__(self): self.chunks = iter([b'a', b'b', b''])
            def read(self, n): return next(self.chunks)
        self.assertEqual(analyzer._read_exact(Stream(), 3), b'ab')

    def test_ffmpeg_nonzero_short_read_rejected(self):
        class Capture:
            def get(self, key): return 3
            def release(self): pass
        class Process:
            def __init__(self): self.stdout = io.BytesIO(b'\x01\x02')
            def wait(self, **kwargs): return 1
            def poll(self): return 1
        class Pool:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def map(self, fn, values, **kwargs): return [0 for _ in values]
        with patch.object(analyzer, 'resolve_ffmpeg_path', return_value='ffmpeg'), \
             patch.object(analyzer.cv2, 'VideoCapture', return_value=Capture()), \
             patch.object(analyzer.subprocess, 'Popen', return_value=Process()), \
             patch.object(analyzer.concurrent.futures, 'ProcessPoolExecutor', Pool):
            with self.assertRaisesRegex(RuntimeError, 'exit=1'):
                analyzer._analyze_video_ffmpeg_sw_passthrough('video', {}, {}, (1, 1), 2, 1)


if __name__ == '__main__':
    unittest.main()
