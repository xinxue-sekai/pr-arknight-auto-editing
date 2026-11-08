"""Conservative, deterministic proposals only; never applies a crop."""
import cv2
import numpy as np
from session_store import ProtocolError


def propose(frames, sampled_indices=None):
    if len(frames) < 3:
        raise ValueError('At least three sampled frames are required')
    if any(f.shape != frames[0].shape for f in frames):
        raise ValueError('Sample dimensions differ')
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames])
    h, w = gray.shape[1:]
    # A border row/column must remain near black in every sampled frame.
    black = np.max(gray, axis=0) <= 12
    rows = np.mean(black, axis=1) >= .995
    cols = np.mean(black, axis=0) >= .995
    def extent(values, cap):
        n = 0
        for value in values[:cap]:
            if not value: break
            n += 1
        return n
    top = extent(rows, h//5); bottom = extent(rows[::-1], h//5)
    left = extent(cols, w//5); right = extent(cols[::-1], w//5)
    candidates = []
    if any((top,bottom,left,right)):
        candidates.append({'kind':'persistent_black_border',
            'content_rect':dict(x=left,y=top,width=w-left-right,height=h-top-bottom),
            'confidence':'candidate', 'evidence':{'max_luma':12,'required_black_fraction':.995}})
    # Top chrome proposal: temporally stable strip followed by a persistent horizontal
    # edge. A static game HUD can look the same: low confidence, always user-confirmed.
    temporal = np.max(gray,axis=0).astype(float)-np.min(gray,axis=0).astype(float)
    stable = np.mean(temporal <= 3,axis=1)
    edges = np.median(np.mean(np.abs(np.diff(gray.astype(float),axis=1)),axis=2),axis=0)
    possible = [y for y in range(max(8,top+1),max(9,h//6))
                if np.mean(stable[top:y]) >= .98 and edges[y-1] >= 15]
    if possible:
        y = max(possible, key=lambda v:(edges[v-1],-v))
        candidates.append({'kind':'possible_top_chrome',
            'content_rect':dict(x=left,y=y,width=w-left-right,height=h-y-bottom),
            'confidence':'low', 'evidence':{'stable_fraction':float(np.mean(stable[top:y])),
                'boundary_luma_jump':float(edges[y-1])},
            'warning':'Static game HUD can resemble a toolbar; inspect before accepting.'})
    return {'applied':False,'requires_confirmation':True,'candidates':candidates,
            'sampled_indices':list(sampled_indices or []),'source_size':{'width':w,'height':h},
            'limitations':['Sparse samples cannot prove a border excludes no gameplay.']}


def suggest(video):
    cap=cv2.VideoCapture(video)
    try:
        if not cap.isOpened(): raise ProtocolError('INVALID_VIDEO','Cannot open video')
        total=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total < 3: raise ProtocolError('INSUFFICIENT_SAMPLES','Video has fewer than three frames')
        indices=sorted(set(int((total-1)*f) for f in (.05,.25,.5,.75,.95)))
        frames=[]
        for index in indices:
            if not cap.set(cv2.CAP_PROP_POS_FRAMES,index):
                raise ProtocolError('SAMPLE_READ_FAILED',f'Cannot seek sample {index}')
            ok,frame=cap.read()
            if not ok: raise ProtocolError('SAMPLE_READ_FAILED',f'Cannot read sample {index}')
            frames.append(frame)
        return propose(frames,indices)
    finally:
        cap.release()
