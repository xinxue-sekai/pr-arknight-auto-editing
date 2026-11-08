import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
import analyzer
import geometry
import pr_cli
import session_store
import reclassify


class AlgorithmTests(unittest.TestCase):
    def test_rect_validation_and_crop(self):
        frame = np.arange(6*8*3, dtype=np.uint8).reshape(6, 8, 3)
        rect = dict(x=2, y=1, width=4, height=3)
        np.testing.assert_array_equal(geometry.crop(frame, rect), frame[1:4, 2:6])
        expected = cv2.cvtColor(cv2.resize(frame[1:4, 2:6], (4, 3), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        np.testing.assert_array_equal(geometry.gray_frame(frame, (4,3), rect), expected)
        self.assertEqual(geometry.ffmpeg_filter((4,3), rect, (8,6)),
                         'crop=4:3:2:1:exact=1,scale=4:3:flags=area,format=gray')
        for invalid in [dict(x=-1,y=0,width=4,height=3), dict(x=0,y=0,width=9,height=3),
                        dict(x=.5,y=0,width=4,height=3), [0,0,4,3]]:
            with self.assertRaises(ValueError): geometry.crop(frame, invalid)

    def test_aspect_ratio_uses_content(self):
        params = pr_cli.merge_params({'content_rect':dict(x=4,y=78,width=1912,height=1098)})
        self.assertEqual(pr_cli.resolve_proc_res(params, dict(width=1920,height=1200)), (400,230))

    def test_score_priority_and_ties(self):
        values = np.array([[.9,.99,.98,1], [.1,.8,.7,.99], [.1,.7,.8,.99],
                           [.1,.8,.8,.99], [.1,.8,.8,.1], [-1,-1,-1,-1]])
        result = analyzer.classify_scores(values, pr_cli.DEFAULT_PARAMS['thresholds'])
        np.testing.assert_array_equal(result, [1,2,3,4,0,0])
        changed = dict(pr_cli.DEFAULT_PARAMS['thresholds'], pause=.95)
        self.assertEqual(analyzer.classify_scores(values, changed)[0], 2)

    def test_manifest_deterministic_and_actual_files(self):
        configs, _ = analyzer.load_templates()
        first = analyzer.template_manifest(configs)
        with patch.object(analyzer.os, 'listdir', wraps=lambda path: list(reversed(original(path)))):
            second, _ = analyzer.load_templates()
        self.assertEqual(first, analyzer.template_manifest(second))
        self.assertEqual(len(first), 6)
        self.assertTrue(all(len(item['source_file_sha256']) == 64 for item in first))

    def test_template_geometry_crops_reference_source(self):
        src = np.zeros((100,200), dtype=np.uint8)
        rng = np.random.default_rng(2)
        template = rng.integers(20,255,(10,10),dtype=np.uint8)
        src[30:40,80:90] = template
        with patch.object(analyzer.os.path, 'exists', return_value=True), \
             patch.object(analyzer.os, 'listdir', return_value=['one.png']), \
             patch.object(analyzer, 'read_template_image', side_effect=lambda path: src.copy() if 'source_images' in path else template.copy()):
            configs, _ = analyzer.load_templates((100,50), dict(x=40,y=10,width=100,height=50))
        self.assertEqual(configs['pause'][0]['roi_orig'], (40,20,10,10))
        self.assertEqual(configs['pause'][0]['source_res'], (100,50))

    def test_sparse_reader_does_not_grab(self):
        class Capture:
            def __init__(self): self.position=0; self.seeks=[]; self.reads=0
            def set(self, prop, value): self.position=value; self.seeks.append(value); return True
            def read(self): self.position+=1; self.reads+=1; return True, np.zeros((4,4,3), np.uint8)
            def get(self, prop): return self.position
            def release(self): pass
            def grab(self): raise AssertionError('must not scan')
        capture = Capture()
        with patch.object(analyzer.cv2, 'VideoCapture', return_value=capture):
            result = analyzer.read_boundary_frames('unused', [900,2,900], (2,2))
        self.assertEqual(capture.seeks, [2,900])
        self.assertEqual(capture.reads, 2)
        self.assertEqual(set(result), {2,900})

    def test_resegmentation_fetches_new_boundaries(self):
        params = pr_cli.merge_params(None)
        params['thresholds']['pause'] = .8
        scores = np.zeros((8,4)); scores[2:5,0] = .85; scores[5,0] = .75
        old = dict(id=0,start=2,end=5,mode='auto',boundary_diff=50,local_del_mask=[0,2,3,0])
        session = dict(total_frames=8,proc_res=[2,2],fps=30,video_path='unused',decode_backend='opencv',
                       pause_segments=[old],score_cache=dict(version=1,classes=list(analyzer.SCORE_CLASSES)))
        arrays = dict(scores=scores, diffs=np.zeros(8),states=np.array([0,0,1,1,1,1,0,0]))
        reader = lambda video, indices, res, rect: {i: np.full((2,2), i*10, np.uint8) for i in indices}
        with patch.object(analyzer, 'read_boundary_frames', side_effect=reader) as spy:
            states, pauses, speeds = reclassify.rebuild(session, arrays, params, [old], [])
        self.assertEqual(spy.call_args.args[1], [1,5])
        self.assertEqual((pauses[0]['start'],pauses[0]['end']), (2,4))
        self.assertEqual(pauses[0]['boundary_diff'], 40)
        self.assertEqual(pauses[0]['local_del_mask'][1:].tolist(), [2,3])
        self.assertTrue(session['analysis_context']['complete'])

    def test_ffmpeg_new_boundaries_explicitly_require_acquisition(self):
        params = pr_cli.merge_params(None)
        scores = np.zeros((4,4)); scores[1:3,0] = .9
        session = dict(total_frames=4,proc_res=[2,2],fps=30,video_path='unused',
            decode_backend='ffmpeg_sw_passthrough',pause_segments=[],
            score_cache=dict(version=1,classes=list(analyzer.SCORE_CLASSES)))
        with patch.object(analyzer, 'read_boundary_frames', side_effect=AssertionError('no fallback')):
            with self.assertRaises(session_store.ProtocolError) as error:
                reclassify.rebuild(session, dict(scores=scores,diffs=np.zeros(4)), params, [], [])
        self.assertEqual(error.exception.code, 'BOUNDARY_READ_REQUIRED')

    def test_end_to_end_score_reclassify(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); video=root/'video.avi'; session=root/'session.json'
            writer=cv2.VideoWriter(str(video),cv2.VideoWriter_fourcc(*'MJPG'),30,(80,60))
            for i in range(10): writer.write(np.full((60,80,3),i*10,np.uint8))
            writer.release()
            params=dict(threads=1,batch=3,content_rect=dict(x=4,y=6,width=72,height=48))
            cli=[sys.executable,pr_cli.__file__]
            result=subprocess.run(cli+['analyze','--video',str(video),'--session-out',str(session),
                '--params',json.dumps(params)],capture_output=True,text=True,encoding='utf-8')
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            before, arrays=session_store.load_session(session)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1])['session'], before)
            self.assertEqual(before, json.loads(session.read_text(encoding='utf-8')))
            self.assertEqual(arrays['scores'].shape,(10,4))
            self.assertEqual(before['content_rect'],params['content_rect'])
            origin=before['analysis_provenance']
            result=subprocess.run(cli+['ranges','--session',str(session),'--session-params',
                '{"thresholds":{"pause":0.9}}'],capture_output=True,text=True,encoding='utf-8')
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            after, newer=session_store.load_session(session)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1])['session'], after)
            self.assertEqual(after, json.loads(session.read_text(encoding='utf-8')))
            np.testing.assert_array_equal(arrays['scores'],newer['scores'])
            self.assertEqual(after['analysis_provenance'],origin)
            self.assertEqual(after['params']['thresholds']['pause'],.9)
            self.assertEqual(after['classification_provenance']['thresholds']['pause'],.9)


original = analyzer.os.listdir
if __name__ == '__main__': unittest.main()
