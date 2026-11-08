import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
import analyzer
import content_suggestion
import pr_cli
import reclassify
import session_store as store
from sparse_ffmpeg import read_frames


class IntegrationTests(unittest.TestCase):
    def test_unicode_health(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'中文安装目录';root.mkdir()
            for p in Path(pr_cli.BASE_DIR).iterdir():
                if p.is_file() and p.suffix=='.py': shutil.copy2(p,root/p.name)
                elif p.is_dir() and p.name.startswith(('templates_','source_images_')): shutil.copytree(p,root/p.name)
            r=subprocess.run([sys.executable,str(root/'pr_cli.py'),'health'],capture_output=True,text=True,encoding='utf-8')
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual(json.loads(r.stdout)['health']['templates_loaded'],6)

    def test_gc_and_stale_writer(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'session.json';payload={'total_frames':3}
            arrays=dict(states=np.zeros(3),diffs=np.zeros(3))
            store.save_session(path,payload,arrays)
            stale=copy.deepcopy(payload)
            for i in range(5): store.save_session(path,payload,arrays)
            self.assertEqual(len(list(Path(temp).glob('*.npz'))),2)
            with self.assertRaises(store.ProtocolError) as error: store.save_session(path,stale,arrays)
            self.assertEqual(error.exception.code,'SESSION_CONFLICT')
            store.load_session(path)

    def test_cross_process_lock_blocks_reader(self):
        from session_lock import session_lock
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'s.json';ready=Path(temp)/'ready'
            store.save_session(path,dict(total_frames=1),dict(states=np.zeros(1),diffs=np.zeros(1)))
            code = ('import sys; from pathlib import Path; '
                    'sys.path.insert(0,sys.argv[1]); import session_store; '
                    'Path(sys.argv[3]).write_text("ready"); '
                    'session_store.load_session(sys.argv[2]); print("loaded")')
            with session_lock(path):
                proc=subprocess.Popen([sys.executable,'-c',code,pr_cli.BASE_DIR,str(path),str(ready)],
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                import time
                deadline=time.monotonic()+10
                while not ready.exists() and time.monotonic()<deadline:
                    time.sleep(.02)
                self.assertTrue(ready.exists())
                with self.assertRaises(subprocess.TimeoutExpired): proc.wait(timeout=.15)
            out,err=proc.communicate(timeout=10)
            self.assertEqual(proc.returncode,0,err)
            self.assertEqual(out.strip(),'loaded')

    def test_progress_actual_count(self):
        records=[]
        def callback(r): pass
        callback.details=lambda r,**d: records.append(dict(ratio=r,**d))
        analyzer._report_scan(callback,100,200,analyzer.time.perf_counter()-2)
        analyzer._report_scan(callback,199,199,analyzer.time.perf_counter()-2,complete=True)
        self.assertEqual(records[0]['ratio'],.5)
        self.assertEqual(records[1]['ratio'],1)
        self.assertEqual(records[1]['total_frames'],199)
        self.assertEqual(records[1]['total_frames_kind'],'decoded')
        self.assertGreater(records[1]['processing_fps'],0)

    def test_suggestions_only_and_stable(self):
        frames=[]
        for n in range(5):
            f=np.zeros((100,160,3),np.uint8);f[8:94,6:154]=80+n*15;frames.append(f)
        first=content_suggestion.propose(frames)
        self.assertEqual(first,content_suggestion.propose(frames))
        self.assertFalse(first['applied']);self.assertTrue(first['requires_confirmation'])
        self.assertEqual(first['candidates'][0]['content_rect'],dict(x=6,y=8,width=148,height=86))

    def test_clip_edits_refused_before_hidden_mask(self):
        with self.assertRaises(store.ProtocolError) as error:
            reclassify.rebuild({}, {}, {}, [], [dict(start=0,end=9,keep_in=1,keep_out=8)])
        self.assertEqual(error.exception.code,'CLIP_EDITS_RESET_REQUIRED')

    def test_explicit_migration_keeps_origin(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'old.json';target=Path(temp)/'new.json';source=Path(temp)/'video';source.write_bytes(b'video')
            provenance=dict(analyzer_sha256=next(iter(store.COMPATIBLE_ANALYZERS)),
                source=store.source_identity(source),templates_sha256=store.template_identity(pr_cli.BASE_DIR))
            payload=dict(total_frames=3,params=pr_cli.merge_params(None),video_path=str(source),analysis_provenance=provenance)
            store.save_session(path,payload,dict(states=np.zeros(3),diffs=np.zeros(3)))
            original=path.read_bytes()
            with self.assertRaises(store.ProtocolError): store.check_recompute(payload,payload['params'],pr_cli.BASE_DIR)
            migrated=store.migrate_session(path,target,pr_cli.BASE_DIR)
            self.assertEqual(path.read_bytes(),original)
            self.assertEqual(migrated['analysis_provenance'],provenance)
            store.check_recompute(migrated,migrated['params'],pr_cli.BASE_DIR)

    def test_sparse_ffmpeg_uses_integer_pts_at_long_timestamps(self):
        # showinfo's rounded pts_time loses sub-frame precision on long recordings.
        probe = dict(streams=[dict(width=2, height=2, r_frame_rate='60/1',
                                  avg_frame_rate='60/1', start_time='0')])
        logs = '[Parsed_showinfo_1] config in time_base: 1/60, frame_rate: 60/1\n'
        for n, tick in enumerate(range(2160000, 2160005)):
            logs += f'[Parsed_showinfo_1] n: {n} pts: {tick} pts_time:36000\n'
        outputs = [subprocess.CompletedProcess([], 0, json.dumps(probe).encode(), b''),
                   subprocess.CompletedProcess([], 0, bytes(range(20)), logs.encode())]
        with patch.object(analyzer, 'resolve_ffmpeg_path', return_value='ffmpeg'), \
             patch('sparse_ffmpeg.shutil.which', return_value='ffprobe'), \
             patch('sparse_ffmpeg.subprocess.run', side_effect=outputs):
            frames = read_frames('unused', [2160002], (2, 2))
        np.testing.assert_array_equal(frames[2160002], np.array([[8, 9], [10, 11]]))

    def test_concurrent_readers_writers_and_gc(self):
        from concurrent.futures import ThreadPoolExecutor
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'session.json'
            store.save_session(path, dict(total_frames=3, counter=0),
                               dict(states=np.zeros(3), diffs=np.zeros(3)))
            def worker(_):
                for i in range(8):
                    payload, arrays = store.load_session(path)
                    self.assertTrue((arrays['states'] == payload['counter']).all())
                    payload['counter'] += 1
                    arrays['states'][:] = payload['counter']
                    try:
                        store.save_session(path, payload, arrays)
                    except store.ProtocolError as exc:
                        self.assertEqual(exc.code, 'SESSION_CONFLICT')
            with ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(worker, range(3)))
            payload, arrays = store.load_session(path)
            self.assertGreater(payload['counter'], 0)
            self.assertTrue((arrays['states'] == payload['counter']).all())
            self.assertEqual(len(list(Path(temp).glob('*.npz'))), 2)

    def test_sparse_ffmpeg_matches_full_decode(self):
        try: ffmpeg=analyzer.resolve_ffmpeg_path()
        except FileNotFoundError: self.skipTest('FFmpeg unavailable')
        with tempfile.TemporaryDirectory() as temp:
            video=str(Path(temp)/'video.avi')
            writer=cv2.VideoWriter(video,cv2.VideoWriter_fourcc(*'MJPG'),30,(80,60))
            for i in range(24): writer.write(np.full((60,80,3),i*8,np.uint8))
            writer.release()
            rect=dict(x=4,y=6,width=72,height=48);res=(36,24)
            from geometry import ffmpeg_filter
            cmd=[ffmpeg,'-v','error','-i',video,'-an','-vf',ffmpeg_filter(res,rect,(80,60)),
                 '-fps_mode','passthrough','-f','rawvideo','-pix_fmt','gray','pipe:1']
            full=subprocess.run(cmd,capture_output=True,check=True).stdout
            values=np.frombuffer(full,np.uint8).reshape(-1,24,36)
            sparse=read_frames(video,[0,7,23],res,rect,ffmpeg)
            for index,frame in sparse.items(): np.testing.assert_array_equal(frame,values[index])


if __name__=='__main__': unittest.main()
