import copy
import json
from pathlib import Path
import unittest
import numpy as np
import pr_cli
import session_store
import static_evidence

# Reviewed ID101, [19070,19100), 60fps: exact cached internal scalar diffs.
STATIC = [.201565220952034,.04871739074587822,.14328260719776154,.0804891288280487,
 .043684784322977066,.04906521737575531,.04251087084412575,.0070108696818351746,
 .02194565162062645,.021489130333065987,.0006956521538086236,.02071739174425602,
 .020630434155464172,.0008804347598925233,.019869565963745117,.020206522196531296,
 .00064130435930565,.04138043522834778,.041902173310518265,.014130434952676296,
 .024250000715255737,.059076085686683655,.033826086670160294,.0199891310185194,
 .06393478065729141,.04990217462182045,.07091304659843445,.06628260761499405,.05844565108418465]


class StaticEvidenceTests(unittest.TestCase):
    def config(self):
        result=pr_cli.merge_params(None)['compare'];result['strict_static_enabled']=True
        return result

    def test_reviewed_static_and_manual_protection(self):
        diffs=np.array([99]+STATIC)
        seg=dict(start=0,end=29,mode='auto',boundary_diff=7.33004347826087,local_del_mask=[0]*30)
        session_store.recompute_pause(seg,diffs,60,self.config())
        self.assertEqual(seg['auto_reason'],'strict_static')
        self.assertEqual(seg['local_del_mask'].tolist(),[1]*30)
        seg['local_del_mask'][4]=3
        session_store.recompute_pause(seg,diffs,60,self.config())
        self.assertEqual(seg['local_del_mask'][4],3)

    def test_default_disabled_preserves_twelve_buffer_frames(self):
        seg=dict(start=0,end=29,mode='auto',boundary_diff=7.33,local_del_mask=[0]*30)
        session_store.recompute_pause(seg,np.array([0]+STATIC),60,pr_cli.DEFAULT_PARAMS['compare'])
        self.assertEqual(int(np.count_nonzero(seg['local_del_mask']==0)),12)
        self.assertFalse(seg['static_evidence']['enabled'])

    def test_activity_short_window_and_drift_protected(self):
        cases=[np.r_[0,np.zeros(20)], np.r_[0,np.zeros(28),.22],
               np.r_[0,np.zeros(23),np.full(6,.11)], np.r_[0,np.full(99,.02)]]
        for diffs in cases:
            self.assertFalse(static_evidence.evaluate(0,len(diffs)-1,diffs,60,self.config())['matched'])
        diffs=np.r_[0,np.zeros(28),np.nan]
        self.assertFalse(static_evidence.evaluate(0,29,diffs,60,self.config())['matched'])

    def test_real_reviewed_operation_mask_unchanged(self):
        path=Path(pr_cli.BASE_DIR).parents[1]/'test_footage/real_20261108/optimized-session.json'
        if not path.exists(): self.skipTest('Reviewed local fixture not installed')
        payload=json.loads(path.read_text(encoding='utf-8'))
        with np.load(path.parent/payload['arrays_file']) as arrays:
            diffs=arrays['diffs'].copy()
        seg=copy.deepcopy(payload['pause_segments'][102])
        before=list(seg['local_del_mask'])
        session_store.recompute_pause(seg,diffs,payload['fps'],self.config())
        self.assertFalse(seg['static_evidence']['matched'])
        self.assertEqual(seg['local_del_mask'].tolist(),before)
        # Both sides of every original motion event remain kept.
        for frame in range(seg['start']+1,seg['end']+1):
            if diffs[frame]>2:
                self.assertEqual(seg['local_del_mask'][frame-seg['start']],0)
                self.assertEqual(seg['local_del_mask'][frame-seg['start']-1],0)

    def test_compare_keys_are_recomputable(self):
        params=pr_cli.merge_params(None);session={'params':params}
        updated=copy.deepcopy(params);updated['compare']['strict_static_enabled']=True
        session_store.check_recompute(session,updated,pr_cli.BASE_DIR)


if __name__=='__main__': unittest.main()
