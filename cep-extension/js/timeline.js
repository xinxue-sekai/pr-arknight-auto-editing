/**
 * timeline.js —— 时间轴画布
 *
 * 从 Python 版 timeline_widget.py 移植，保持完全一致的视觉语义：
 *
 *   ┌─────────────────────────────────────┐  y=0
 *   │  (留白)                              │
 *   │  ▓▓ 暂停段色带  15 ~ h-25            │  亮绿=保留 暗棕=自动删 红棕=手动删
 *   │  ▒▒ clip 色带   37 ~ h-25            │  青=保留区 深青=删除区
 *   │  ┃  keep_in/keep_out 手柄 32 ~ h-20  │  亮青，可拖拽
 *   │  ▔▔ 变速色带    h-20 ~ h             │  蓝=1x 紫=2x 绿=0.2x
 *   └─────────────────────────────────────┘  y=h
 *
 * 交互：滚轮缩放（以光标为中心）| 中键或 Shift+左键拖动平移
 *       左键选中暂停段 | 右键切换该片段的保留/删除 | 拖动亮青手柄调边缘
 */
(function () {
    'use strict';

    const FRAME_NORMAL = 0, FRAME_PAUSE = 1, FRAME_1X = 2, FRAME_2X = 3, FRAME_02X = 4;

    // 与 Python 版 col_map 一一对应
    const COL = {
        keepAuto:   'rgb(100,200,50)',   // 0 自动保留
        delAuto:    'rgb(68,51,0)',      // 1 自动删除
        delManual:  'rgb(180,50,50)',    // 2 手动删除（作废）
        keepManual: 'rgb(100,200,50)',   // 3 手动保留（抢救）
        selected:   'rgb(255,255,255)',
        clipKeep:   'rgb(32,178,170)',
        clipDel:    'rgb(20,60,60)',
        handle:     'rgb(0,230,200)',
        bg:         '#1A1A1A',
        tick:       'rgba(255,255,255,0.18)',
        tickLabel:  'rgba(255,255,255,0.45)',
        playhead:   'rgb(255,60,60)'
    };

    const SPEED_COL = {
        [FRAME_1X]:   'rgb(30,144,255)',
        [FRAME_2X]:   'rgb(147,112,219)',
        [FRAME_02X]:  'rgb(60,179,113)'
    };

    const HEIGHT = 88;
    const HANDLE_HALF_WIDTH = 3;

    class Timeline {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');

            this.totalFrames = 0;
            this.fps = 30;
            this.zoom = 1;            // 1 = 全片适配画布宽度
            this.scrollFrame = 0;     // 视口左边界对应的帧号
            this.currentFrame = 0;

            this.pauseSegments = [];
            this.speedSegments = [];
            this.clipSegments = [];

            this.selectedPauseId = null;
            this.onSelect = null;     // (pauseId|null) => void
            this.onChange = null;     // 用户改动掩码/手柄后触发，供上层重算

            this._drag = null;        // {mode:'pan'|'handle', ...}
            this._lastX = 0;

            this._bindEvents();
            this.resize();
        }

        // ------------------------------------------------------------
        //  数据与尺寸
        // ------------------------------------------------------------

        /**
         * @param {object}  d             数据
         * @param {boolean} preserveView  true = 保留当前缩放/滚动/选中状态。
         *                                重算后刷新数据时必须为 true，否则用户
         *                                正在放大查看的区域会被弹回全片视图。
         */
        setData(d, preserveView) {
            const keepZoom = this.zoom, keepScroll = this.scrollFrame, keepSel = this.selectedPauseId;

            this.totalFrames = d.totalFrames || 0;
            this.fps = d.fps || 30;
            this.pauseSegments = d.pauseSegments || [];
            this.speedSegments = d.speedSegments || [];
            this.clipSegments = d.clipSegments || [];

            if (preserveView) {
                this.zoom = keepZoom;
                this.scrollFrame = keepScroll;
                this.selectedPauseId = keepSel;
                this._clampScroll();
            } else {
                this.selectedPauseId = null;
                this.zoom = 1;
                this.scrollFrame = 0;
            }
            this.draw();
        }

        /** 按 id 取当前暂停段（重算后段对象会被替换，需重新查找）。 */
        getPauseById(id) {
            if (id === null || id === undefined) return null;
            return this.pauseSegments.find(s => s.id === id) || null;
        }

        resize() {
            const dpr = window.devicePixelRatio || 1;
            const w = this.canvas.clientWidth || 380;
            // 用 CSS 尺寸 * dpr 设置位图分辨率，避免高分屏发虚
            this.canvas.width = Math.max(1, Math.round(w * dpr));
            this.canvas.height = Math.round(HEIGHT * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.cssWidth = w;
            this.draw();
        }

        // ------------------------------------------------------------
        //  坐标换算
        // ------------------------------------------------------------

        get pxPerFrame() {
            if (this.totalFrames <= 0) return 1;
            return (this.cssWidth / this.totalFrames) * this.zoom;
        }

        get visibleFrames() {
            const p = this.pxPerFrame;
            return p > 0 ? this.cssWidth / p : this.totalFrames;
        }

        f2x(frame) { return (frame - this.scrollFrame) * this.pxPerFrame; }
        x2f(x) { return this.scrollFrame + x / this.pxPerFrame; }

        _clampScroll() {
            const maxScroll = Math.max(0, this.totalFrames - this.visibleFrames);
            this.scrollFrame = Math.min(Math.max(0, this.scrollFrame), maxScroll);
        }

        // ------------------------------------------------------------
        //  绘制
        // ------------------------------------------------------------

        draw() {
            const ctx = this.ctx, w = this.cssWidth, h = HEIGHT;
            if (!ctx) return;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = COL.bg;
            ctx.fillRect(0, 0, w, h);

            if (this.totalFrames <= 0) {
                ctx.fillStyle = 'rgba(255,255,255,0.35)';
                ctx.font = '11px Consolas, monospace';
                ctx.textAlign = 'center';
                ctx.fillText('尚未分析 —— 请先选择素材并点击「开始分析」', w / 2, h / 2);
                ctx.textAlign = 'left';
                return;
            }

            this._drawTicks(w, h);
            this._drawSpeedBand(w, h);
            this._drawPauseBand(w, h);
            this._drawClipBand(w, h);
            this._drawPlayhead(w, h);
        }

        _drawTicks(w, h) {
            const ctx = this.ctx;
            // 目标刻度间距约 70px，据此选一个「整齐」的帧间隔
            const target = 70 / this.pxPerFrame;
            const steps = [1, 2, 5, 10, 15, 30, 60, 150, 300, 600, 1800, 3600, 9000];
            let step = steps[steps.length - 1];
            for (const s of steps) { if (s >= target) { step = s; break; } }

            const first = Math.max(0, Math.ceil(this.scrollFrame / step) * step);
            const last = Math.min(this.totalFrames, this.scrollFrame + this.visibleFrames);

            ctx.font = '9px Consolas, monospace';
            ctx.fillStyle = COL.tickLabel;
            for (let f = first; f <= last; f += step) {
                const x = Math.round(this.f2x(f)) + 0.5;
                if (x < 0 || x > w) continue;
                ctx.strokeStyle = COL.tick;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, 12);
                ctx.stroke();
                ctx.fillText(this._fmtFrame(f), x + 2, 10);
            }
        }

        _fmtFrame(f) {
            const totalSec = f / (this.fps || 30);
            const m = Math.floor(totalSec / 60);
            const s = Math.floor(totalSec % 60);
            const fr = Math.floor(f % (this.fps || 30));
            return m > 0 ? `${m}:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`
                         : `${s}.${String(fr).padStart(2, '0')}`;
        }

        _drawSpeedBand(w, h) {
            const ctx = this.ctx;
            const y1 = h - 20, y2 = h;
            for (const seg of this.speedSegments) {
                const x1 = this.f2x(seg.start), x2 = this.f2x(seg.end + 1);
                if (x2 < 0 || x1 > w) continue;
                ctx.fillStyle = SPEED_COL[seg.type] || 'rgb(90,90,90)';
                // 至少 1px，否则窄区间在缩小时完全看不见
                ctx.fillRect(x1, y1, Math.max(1, x2 - x1), y2 - y1);
            }
        }

        _drawPauseBand(w, h) {
            const ctx = this.ctx;
            const y1 = 15, y2 = h - 25;

            for (const seg of this.pauseSegments) {
                const x1 = this.f2x(seg.start), x2 = this.f2x(seg.end + 1);
                if (x2 < 0 || x1 > w) continue;
                const mode = seg.mode || 'auto';

                if (mode === 'all') {
                    this._fillSpan(x1, x2, y1, y2, COL.delAuto, w);
                } else if (mode === 'keep') {
                    this._fillSpan(x1, x2, y1, y2, COL.keepAuto, w);
                } else {
                    // auto：按 local_del_mask 逐段上色，这是本工具最核心的可视化
                    const mask = seg.local_del_mask;
                    if (!mask || !mask.length) {
                        this._fillSpan(x1, x2, y1, y2, COL.keepAuto, w);
                    } else {
                        let cur = mask[0], runStart = 0;
                        for (let i = 1; i <= mask.length; i++) {
                            if (i === mask.length || mask[i] !== cur) {
                                const a = this.f2x(seg.start + runStart);
                                const b = this.f2x(seg.start + i);
                                this._fillSpan(a, b, y1, y2, this._maskColor(cur), w);
                                if (i < mask.length) { cur = mask[i]; runStart = i; }
                            }
                        }
                    }
                }

                // 选中态：底部白色指示条
                if (this.selectedPauseId !== null && seg.id === this.selectedPauseId) {
                    this._fillSpan(x1, x2, y2, y2 + 3, COL.selected, w);
                }
            }
        }

        _maskColor(v) {
            if (v === 1) return COL.delAuto;
            if (v === 2) return COL.delManual;
            if (v === 3) return COL.keepManual;
            return COL.keepAuto;   // 0
        }

        _drawClipBand(w, h) {
            const ctx = this.ctx;
            const y1 = 37, y2 = h - 25;
            const hy1 = 32, hy2 = h - 20;

            for (const seg of this.clipSegments) {
                const x1 = this.f2x(seg.start), x2 = this.f2x(seg.end + 1);
                if (x2 < 0 || x1 > w) continue;
                const xki = this.f2x(seg.keep_in);
                const xko = this.f2x(seg.keep_out + 1);

                this._fillSpan(x1, xki, y1, y2, COL.clipDel, w);
                this._fillSpan(xki, xko, y1, y2, COL.clipKeep, w);
                this._fillSpan(xko, x2, y1, y2, COL.clipDel, w);

                // 拖拽手柄
                ctx.fillStyle = COL.handle;
                for (const hx of [xki, xko]) {
                    if (hx >= -HANDLE_HALF_WIDTH && hx <= w + HANDLE_HALF_WIDTH) {
                        ctx.fillRect(Math.round(hx) - HANDLE_HALF_WIDTH, hy1,
                                     HANDLE_HALF_WIDTH * 2 + 1, hy2 - hy1);
                    }
                }
            }
        }

        _fillSpan(x1, x2, y1, y2, color, w) {
            const ctx = this.ctx;
            let a = Math.max(0, Math.round(x1)), b = Math.min(w, Math.round(x2));
            if (b <= a && x2 > x1) b = a + 1;   // 亚像素区间也画 1px
            if (b > a) { ctx.fillStyle = color; ctx.fillRect(a, y1, b - a, y2 - y1); }
        }

        _drawPlayhead(w, h) {
            const x = Math.round(this.f2x(this.currentFrame)) + 0.5;
            if (x < 0 || x > w) return;
            const ctx = this.ctx;
            ctx.strokeStyle = COL.playhead;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            ctx.lineWidth = 1;
        }

        // ------------------------------------------------------------
        //  命中测试
        // ------------------------------------------------------------

        _hitPause(frame) {
            for (const seg of this.pauseSegments) {
                if (frame >= seg.start && frame <= seg.end) return seg;
            }
            return null;
        }

        /** 返回光标下的 clip 手柄，阈值 5px。 */
        _hitHandle(x, y) {
            if (y < 32 || y > HEIGHT - 20) return null;
            for (const seg of this.clipSegments) {
                for (const side of ['keep_in', 'keep_out']) {
                    const hx = this.f2x(side === 'keep_in' ? seg.keep_in : seg.keep_out + 1);
                    if (Math.abs(hx - x) <= 5) return { seg, side };
                }
            }
            return null;
        }

        // ------------------------------------------------------------
        //  事件
        // ------------------------------------------------------------

        _bindEvents() {
            const c = this.canvas;
            c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
            c.addEventListener('mousedown', e => this._onDown(e));
            window.addEventListener('mousemove', e => this._onMove(e));
            window.addEventListener('mouseup', e => this._onUp(e));
            c.addEventListener('contextmenu', e => { e.preventDefault(); this._onRightClick(e); });
        }

        _local(e) {
            const r = this.canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }

        _onWheel(e) {
            e.preventDefault();
            if (this.totalFrames <= 0) return;
            const { x } = this._local(e);
            const anchor = this.x2f(x);            // 缩放时保持光标下的帧不动
            const factor = e.deltaY < 0 ? 1.25 : 0.8;
            const maxZoom = Math.max(1, this.totalFrames / 4);
            this.zoom = Math.min(maxZoom, Math.max(1, this.zoom * factor));
            this.scrollFrame = anchor - x / this.pxPerFrame;
            this._clampScroll();
            this.draw();
        }

        _onDown(e) {
            if (this.totalFrames <= 0) return;
            const { x, y } = this._local(e);
            this._lastX = x;

            // 中键 或 Shift+左键 → 平移
            if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
                e.preventDefault();
                this._drag = { mode: 'pan' };
                return;
            }
            if (e.button !== 0) return;

            const handle = this._hitHandle(x, y);
            if (handle) {
                this._drag = { mode: 'handle', seg: handle.seg, side: handle.side };
                return;
            }

            // 左键：选中暂停段（点在暂停带上才生效）
            if (y >= 15 && y <= HEIGHT - 25) {
                const f = Math.round(this.x2f(x));
                const seg = this._hitPause(f);
                this.selectedPauseId = seg ? seg.id : null;
                if (this.onSelect) this.onSelect(this.selectedPauseId, seg);
                this.draw();
            }
        }

        _onMove(e) {
            if (!this._drag) return;
            const { x } = this._local(e);
            const dx = x - this._lastX;
            this._lastX = x;

            if (this._drag.mode === 'pan') {
                this.scrollFrame -= dx / this.pxPerFrame;
                this._clampScroll();
                this.draw();
            } else if (this._drag.mode === 'handle') {
                const f = Math.max(0, Math.min(this.totalFrames - 1, Math.round(this.x2f(x))));
                const seg = this._drag.seg;
                if (this._drag.side === 'keep_in') {
                    // 允许 keep_in > keep_out，语义为「整段都不要」
                    seg.keep_in = Math.min(f, seg.end);
                } else {
                    seg.keep_out = Math.max(f - 1, seg.start - 1);
                }
                if (this.onChange) this.onChange('handle');
                this.draw();
            }
        }

        _onUp() {
            if (this._drag && this._drag.mode === 'handle' && this.onChange) {
                this.onChange('handle-end');
            }
            this._drag = null;
        }

        /**
         * 右键：切换光标所在「同值连续片段」的保留/删除状态。
         * 对应 README 里「对亮绿色/深棕色/红色片段右键单击可切换是否去掉该片段」。
         */
        _onRightClick(e) {
            if (this.totalFrames <= 0) return;
            const { x, y } = this._local(e);
            if (y < 15 || y > HEIGHT - 25) return;

            const f = Math.round(this.x2f(x));
            const seg = this._hitPause(f);
            if (!seg) return;

            const local = f - seg.start;
            const mask = seg.local_del_mask;

            if (seg.mode === 'all') {
                // 整段全删 → 恢复为按设置裁剪
                seg.mode = 'auto';
            } else if (seg.mode === 'keep') {
                // 整段全留 → 改为整段全删
                seg.mode = 'all';
            } else if (mask && local >= 0 && local < mask.length) {
                const cur = mask[local];
                // 找到与光标处同值的连续 run，整段翻转
                let s = local, en = local;
                while (s > 0 && mask[s - 1] === cur) s--;
                while (en < mask.length - 1 && mask[en + 1] === cur) en++;
                const isDeleted = (cur === 1 || cur === 2);
                const next = isDeleted ? 3 : 2;   // 删→抢救(3)，留→作废(2)
                for (let i = s; i <= en; i++) mask[i] = next;
            } else {
                seg.mode = 'all';
            }

            this.selectedPauseId = seg.id;
            if (this.onSelect) this.onSelect(seg.id, seg);
            if (this.onChange) this.onChange('mask');
            this.draw();
        }

        /** 面板按钮调用：批量设置某个/全部暂停段的模式。 */
        setPauseMode(pauseId, mode) {
            const apply = seg => { seg.mode = mode; };
            if (pauseId === null || pauseId === undefined) {
                this.pauseSegments.forEach(apply);
            } else {
                const seg = this.pauseSegments.find(s => s.id === pauseId);
                if (seg) apply(seg);
            }
            if (this.onChange) this.onChange('mode');
            this.draw();
        }

        setPlayhead(frame) {
            this.currentFrame = frame || 0;
            this.draw();
        }

        /** 保证播放头在可视范围内（跟随播放）。 */
        ensureVisible(frame) {
            this.currentFrame = frame;
            const left = this.scrollFrame, right = left + this.visibleFrames;
            if (frame < left || frame >= right) {
                this.scrollFrame = Math.max(0, frame - this.visibleFrames / 2);
                this._clampScroll();
            }
            this.draw();
        }
    }

    window.ArknightTimeline = Timeline;
    window.ArknightFrameTypes = { FRAME_NORMAL, FRAME_PAUSE, FRAME_1X, FRAME_2X, FRAME_02X };
})();
