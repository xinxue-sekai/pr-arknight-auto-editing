/**
 * main.js —— 面板主控
 *
 * 职责：串联三方
 *   ① CEP 面板 DOM（用户交互）
 *   ② Node 桥接层 bridge.js（调用 Python 分析）
 *   ③ ExtendScript hostscript.jsx（把结果落地到 Premiere 时间轴）
 *
 * 数据流：
 *   选中素材 → Python 分析 → session{pause/speed/clip 段, keep_ranges, markers}
 *            → canvas 时间轴可视化与微调 → Python 重算 keep_ranges
 *            → JSX 建子剪辑并拼装成新序列 + 写变速标记
 */
(function () {
    'use strict';

    const cs = new CSInterface();
    const B = window.ArknightBridge;

    // 与 Python 侧 frame_types.py 保持一致
    const FT = { NORMAL: 0, PAUSE: 1, X1: 2, X2: 3, X02: 4 };

    const state = {
        session: null,        // Python 返回的完整会话对象
        sessionPath: '',
        videoPath: '',
        fps: 30,
        totalFrames: 0,
        hostInfo: null,
        timeline: null,
        busy: false,
        selectedPauseId: null
    };

    let recomputeTimer = null;

    const $ = id => document.getElementById(id);

    // ------------------------------------------------------------------
    //  UI 辅助
    // ------------------------------------------------------------------

    function log(msg) {
        const el = $('log');
        const t = new Date().toTimeString().slice(0, 8);
        el.textContent += `[${t}] ${msg}\n`;
        // 只保留最近 400 行，长时间运行不至于吃满内存
        const lines = el.textContent.split('\n');
        if (lines.length > 400) el.textContent = lines.slice(-400).join('\n');
        el.scrollTop = el.scrollHeight;
    }

    function status(text, level) {
        $('status-text').textContent = text;
        $('dot').className = 'dot dot-' + (level || 'unknown');
    }

    function progress(ratio, text) {
        $('progress-bar').style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
        if (text !== undefined) $('progress-text').textContent = text;
    }

    function setBusy(busy, label) {
        state.busy = busy;
        $('btn-analyze').disabled = busy || !state.videoPath;
        $('btn-cancel').disabled = !busy;
        $('btn-apply').disabled = busy || !state.session;
        $('btn-edl').disabled = busy || !state.session;
        $('btn-recompute').disabled = busy || !state.session;
        if (label) status(label, busy ? 'busy' : 'ok');
    }

    function num(id, fallback) {
        const v = parseFloat($(id).value);
        return isFinite(v) ? v : fallback;
    }

    function fmtSec(sec) {
        if (!isFinite(sec)) return '--';
        const m = Math.floor(sec / 60), s = (sec % 60);
        return m > 0 ? `${m}分${s.toFixed(1)}秒` : `${s.toFixed(1)}秒`;
    }

    // ------------------------------------------------------------------
    //  ExtendScript 调用封装
    // ------------------------------------------------------------------

    /**
     * 调用 hostscript.jsx 里的 Arknight.<fn>(arg)。
     * 参数用 JSON.stringify 生成合法的 ExtendScript 字面量（自动处理转义）。
     * JSX 侧一律返回 JSON 字符串，由 evalJSON 解析。
     */
    function jsx(fn, arg) {
        const call = (arg === undefined)
            ? `Arknight.${fn}()`
            : `Arknight.${fn}(${JSON.stringify(arg)})`;
        return cs.evalJSON(call).then(res => {
            if (res && res.ok === false) {
                throw new Error(`[${res.stage || fn}] ${res.error || '未知错误'}`);
            }
            return res;
        });
    }

    // ------------------------------------------------------------------
    //  参数收集
    // ------------------------------------------------------------------

    function collectParams() {
        const threads = Math.floor(num('p-threads', 0));
        const p = {
            // 高度固定传 225，Python 侧 resolve_proc_res 会按源素材宽高比自动推算
            proc_res: [Math.floor(num('p-procw', 400)), 225],
            batch: Math.floor(num('p-batch', 128)),
            thresholds: {
                pause: num('p-thr-pause', 0.7),
                speed_1x: num('p-thr-1x', 0.7),
                speed_2x: num('p-thr-2x', 0.7),
                speed_0_2x: num('p-thr-02x', 0.7)
            },
            compare: {
                still_time_thresh: num('p-still', 0.1),
                motion_thresh: num('p-motion', 2.0),
                boundary_thresh: num('p-boundary', 5.0)
            },
            decode_backend: $('p-backend').value || 'opencv',
            // Premiere 时间轴无法承载抽帧产生的大量单帧碎片，变速统一走标记提示
            speedup_1x: false,
            speedup_02: false,
            speedup_02_factor: 1,
            suggest_speed: {
                [String(FT.X1)]: num('p-sp1x', 200),
                [String(FT.X2)]: num('p-sp2x', 100),
                [String(FT.X02)]: num('p-sp02x', 500)
            }
        };
        // 0 表示「用满所有核心」，此时不传该字段，交给 Python 取默认值
        if (threads > 0) p.threads = threads;
        return p;
    }

    /** 把 Python 会话里的参数回填到表单，保证界面与实际生效值一致。 */
    function paramsToForm(p) {
        if (!p) return;
        const set = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = v; };
        if (p.proc_res) set('p-procw', p.proc_res[0]);
        set('p-batch', p.batch);
        if (p.thresholds) {
            set('p-thr-pause', p.thresholds.pause);
            set('p-thr-1x', p.thresholds.speed_1x);
            set('p-thr-2x', p.thresholds.speed_2x);
            set('p-thr-02x', p.thresholds.speed_0_2x);
        }
        if (p.compare) {
            set('p-still', p.compare.still_time_thresh);
            set('p-motion', p.compare.motion_thresh);
            set('p-boundary', p.compare.boundary_thresh);
        }
        if (p.decode_backend) set('p-backend', p.decode_backend);
        if (p.suggest_speed) {
            set('p-sp1x', p.suggest_speed[String(FT.X1)]);
            set('p-sp2x', p.suggest_speed[String(FT.X2)]);
            set('p-sp02x', p.suggest_speed[String(FT.X02)]);
        }
    }

    // ------------------------------------------------------------------
    //  会话 → 时间轴
    // ------------------------------------------------------------------

    function applySession(session, preserveView) {
        state.session = session;
        state.sessionPath = session.__sessionPath || state.sessionPath;
        state.fps = session.fps || 30;
        state.totalFrames = session.total_frames || 0;

        state.timeline.setData({
            totalFrames: state.totalFrames,
            fps: state.fps,
            pauseSegments: session.pause_segments || [],
            speedSegments: session.speed_segments || [],
            clipSegments: session.clip_segments || []
        }, preserveView);

        // 重算后段对象被整体替换，选中态需要按 id 重新绑定到新对象上
        if (preserveView && state.timeline.selectedPauseId !== null) {
            updateSelectedInfo(state.timeline.selectedPauseId,
                               state.timeline.getPauseById(state.timeline.selectedPauseId));
        }

        updateStats();
        setBusy(false);
    }

    function updateStats() {
        const s = state.session;
        if (!s) { $('stats').textContent = '尚未分析'; return; }
        const st = s.stats || {};
        const pauses = s.pause_segments || [];
        const speeds = s.speed_segments || [];
        const markers = s.markers || [];
        $('stats').innerHTML =
            `源片 <b>${fmtSec(state.totalFrames / state.fps)}</b> · ` +
            `${state.totalFrames} 帧 @ ${state.fps.toFixed(2)}fps<br>` +
            `保留 <span class="keep">${fmtSec(st.kept_seconds || 0)}</span>` +
            `（${st.segment_count || 0} 段） · ` +
            `删除 <span class="drop">${fmtSec(st.removed_seconds || 0)}</span>` +
            ` · 压缩至 <b>${Math.round((st.ratio || 0) * 100)}%</b><br>` +
            `暂停 <b>${pauses.length}</b> 处 · 变速 <b>${speeds.length}</b> 段` +
            ` · 待处理标记 <b>${markers.length}</b> 个` +
            (s.context_complete ? '' : '<br><span class="muted">注：边界差分走了二次扫片回退路径</span>');
    }

    function updateSelectedInfo(pauseId, seg) {
        state.selectedPauseId = pauseId;
        const el = $('selected-info');
        if (pauseId === null || !seg) {
            el.textContent = '未选中任何暂停片段（在时间轴暂停带上左键点击）';
            return;
        }
        const modeName = { keep: '全部保留', auto: '按设置裁剪', all: '全部裁剪' }[seg.mode] || seg.mode;
        const len = seg.end - seg.start + 1;
        el.innerHTML =
            `已选 <b>ID ${seg.id}</b> · 帧 ${seg.start}~${seg.end}（${len} 帧 / ${(len / state.fps).toFixed(2)}s）<br>` +
            `模式 <b>${modeName}</b> · 边界差异 <b>${(seg.boundary_diff || 0).toFixed(1)}</b>`;
    }

    // ------------------------------------------------------------------
    //  从 Premiere 获取素材
    // ------------------------------------------------------------------

    async function pickFromPR() {
        try {
            status('正在读取 Premiere 项目…', 'busy');
            const info = await jsx('getHostInfo');
            state.hostInfo = info;

            const parts = [`Premiere ${info.appVersion}`, info.projectName];
            if (info.activeSequence) {
                const sq = info.activeSequence;
                parts.push(`序列「${sq.name}」${sq.fps ? ' @ ' + sq.fps.toFixed(2) + 'fps' : ''}`);
            }
            $('host-info').textContent = parts.filter(Boolean).join(' · ');

            const box = $('candidates');
            box.innerHTML = '';
            const cands = info.candidates || [];

            if (cands.length === 0) {
                box.innerHTML = '<span class="note">未找到候选素材。请在项目面板或时间轴中选中一个视频片段后重试，或在上方手动填写路径。</span>';
                status('未找到候选素材', 'warn');
                return;
            }

            // 去重（同一素材可能同时出现在项目面板选中和时间轴选中里）
            const seen = new Set();
            const uniq = cands.filter(c => {
                const k = c.mediaPath.toLowerCase();
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });

            uniq.forEach(c => {
                const b = document.createElement('button');
                b.className = 'btn btn-sm';
                b.textContent = c.name || c.mediaPath;
                b.title = c.mediaPath;
                b.addEventListener('click', () => setVideoPath(c.mediaPath));
                box.appendChild(b);
            });

            // 只有一个候选时直接采用，省一次点击
            if (uniq.length === 1) setVideoPath(uniq[0].mediaPath);
            status(`找到 ${uniq.length} 个候选素材`, 'ok');
            log(`getHostInfo: ${JSON.stringify({ v: info.appVersion, n: uniq.length })}`);
        } catch (e) {
            status('读取 Premiere 失败', 'err');
            log('getHostInfo 失败: ' + e.message);
            $('host-info').textContent = '无法连接 Premiere：' + e.message;
        }
    }

    function setVideoPath(p) {
        if (!p) return;
        state.videoPath = p;
        $('video-path').value = p;
        $('btn-analyze').disabled = state.busy;
        // EDL 默认与源素材同目录
        $('edl-path').value = B.defaultEdlPath(p);
        status('素材已选定，可以开始分析', 'ok');
    }

    // ------------------------------------------------------------------
    //  分析
    // ------------------------------------------------------------------

    async function startAnalyze() {
        const vp = ($('video-path').value || '').trim();
        if (!vp) { status('请先指定源素材', 'warn'); return; }
        state.videoPath = vp;

        setBusy(true, '正在启动 Python 分析…');
        progress(0, '准备中');
        log('开始分析: ' + vp);
        state._lastErr = '';

        try {
            const r = await B.analyze(vp, collectParams(), Object.assign({
                onProgress: m => {
                    progress(m.ratio, `${m.message || m.stage}  ${Math.round(m.ratio * 100)}%`);
                    status(m.message || '分析中…', 'busy');
                },
                onLog: s => {
                    // Python stderr 里常混着 OpenCV 的逐帧告警，量很大。
                    // 只留尾部若干字符，出错时回显；不设上限会一路吃内存。
                    state._lastErr = ((state._lastErr || '') + s).slice(-4000);
                }
            }, timeoutOpt()));

            const session = r.session;
            session.__sessionPath = r.sessionPath;
            state._lastErr = '';

            applySession(session, false);
            paramsToForm(session.params);
            $('btn-import-edl').disabled = false;

            const st = session.stats || {};
            status(`分析完成：${(session.pause_segments || []).length} 处暂停，保留 ${Math.round((st.ratio || 0) * 100)}%`, 'ok');
            log(`分析完成 L=${session.total_frames} fps=${session.fps} ` +
                `pauses=${(session.pause_segments || []).length} ` +
                `speeds=${(session.speed_segments || []).length} ` +
                `ranges=${(session.keep_ranges || []).length} ` +
                `markers=${(session.markers || []).length} ` +
                `ctx=${session.context_complete}`);

            if ((session.pause_segments || []).length === 0) {
                log('提示：未识别到任何暂停段。请检查 templates_pause/ 里的模板是否与本次录屏的分辨率/UI 匹配，或适当调低「暂停」匹配阈值。');
            }
        } catch (e) {
            setBusy(false);
            // 用户主动取消不是错误，cancelAnalyze 已经报过状态了，这里不再刷屏
            if (B.CODE && e.code === B.CODE.CANCELLED) return;

            progress(0, '分析失败');
            status('分析失败', 'err');
            log('分析失败: ' + e.message);
            if (e.detail) log(e.detail.split('\n').slice(-6).join('\n'));
            // stderr 之前被默默攒着却从不显示，等于把最关键的诊断信息丢了
            const tail = (state._lastErr || '').trim();
            if (tail && !e.detail) log('Python stderr 末尾:\n' + tail.split('\n').slice(-8).join('\n'));
            const hint = hintFor(e);
            if (hint) log(hint);
        }
    }

    function cancelAnalyze() {
        if (B.cancel()) {
            status('已取消', 'warn');
            progress(0, '已取消');
            setBusy(false);
            log('用户取消了分析');
        }
    }

    // ------------------------------------------------------------------
    //  重算（调参或时间轴微调后）
    // ------------------------------------------------------------------

    /**
     * @param {boolean} recomputeMasks true = 用最新阈值重算每段内部掩码与边界判定
     *                                 false = 仅按用户的手动编辑重算保留区间
     */
    async function recompute(recomputeMasks) {
        if (!state.session || !state.sessionPath) return;
        if (state.busy) return;

        const tl = state.timeline;
        const overrides = {
            pause_segments: tl.pauseSegments,
            clip_segments: tl.clipSegments,
            speed_segments: tl.speedSegments,
            recompute_masks: !!recomputeMasks
        };

        setBusy(true, recomputeMasks ? '正在按新参数重算…' : '正在重算保留区间…');
        try {
            const r = await B.recompute(state.sessionPath, overrides, collectParams(), timeoutOpt());
            const session = r.session;
            session.__sessionPath = state.sessionPath;
            applySession(session, true);
            status('已重算', 'ok');
            log(`重算完成 ranges=${(session.keep_ranges || []).length} ` +
                `kept=${(session.stats || {}).segment_count} 段`);
        } catch (e) {
            setBusy(false);
            if (B.CODE && e.code === B.CODE.CANCELLED) return;
            status('重算失败', 'err');
            log('重算失败: ' + e.message);
            if (e.detail) log(e.detail.split('\n').slice(-6).join('\n'));
            const hint = hintFor(e);
            if (hint) log(hint);
        }
    }

    /** 时间轴交互回调：拖拽过程中不重算，松手后统一算一次。 */
    function onTimelineChange(kind) {
        if (kind === 'handle') return;   // 拖动中，先只重绘
        if (recomputeTimer) clearTimeout(recomputeTimer);
        recomputeTimer = setTimeout(() => {
            recomputeTimer = null;
            recompute(false);
        }, 220);
    }

    // ------------------------------------------------------------------
    //  落地到 Premiere
    // ------------------------------------------------------------------

    async function applyToPremiere() {
        if (!state.session) { status('请先分析', 'warn'); return; }
        const ranges = state.session.keep_ranges || [];
        if (!ranges.length) { status('没有可落地的保留区间', 'warn'); return; }
        if (!state.videoPath) { status('缺少源素材路径', 'warn'); return; }

        const payload = {
            mediaPath: state.videoPath,
            fps: state.fps,
            ranges: ranges,
            markers: state.session.markers || [],
            sequenceName: ($('seq-name').value || '明日方舟自动剪辑').trim(),
            binName: 'ArknightAutoEditing',
            sourceOffsetTicks: '0',
            addMarkers: $('opt-markers').checked,
            openSequence: $('opt-open').checked
        };

        setBusy(true, `正在写入 Premiere（${ranges.length} 段）…`);
        log(`applyEdit: ${ranges.length} 段, ${payload.markers.length} 个标记 → ${payload.sequenceName}`);

        try {
            // 大负载走临时文件，绕开 evalScript 的长度与转义限制
            const p = B.writePayload('apply.json', payload);
            const res = await jsx('applyEdit', p);

            setBusy(false);
            // clipsInSequence 是从序列里读回的真实数量，-1 表示读不到
            const landed = res.clipsInSequence;
            const mismatch = landed >= 0 && landed !== res.subclipsCreated;
            const msg = `已生成序列「${res.sequenceName}」：${landed >= 0 ? landed : res.subclipsCreated} 段，` +
                        `${res.markersAdded} 个变速标记`;
            status(msg, (res.clipsFailed > 0 || mismatch) ? 'warn' : 'ok');
            log(`落地成功 subclips=${res.subclipsCreated} inSeq=${landed} ` +
                `failed=${res.clipsFailed} markers=${res.markersAdded} ` +
                `seqFps=${res.sequenceFps} endTicks=${res.sequenceEndTicks}`);

            if (mismatch) {
                log(`⚠ 序列内实际 ${landed} 段，与创建的 ${res.subclipsCreated} 个子剪辑不符。` +
                    `可能是 createNewSequenceFromClips 未全部插入，请检查时间轴；` +
                    `必要时改用「导出 EDL」→「导入 EDL」。`);
            }

            // 帧对齐校验：序列实际时长应等于 Python 算出的保留帧数
            const st = state.session.stats || {};
            const expectTicks = String(Math.round(
                (st.kept_frames || 0) * (254016000000 / state.fps)));
            if (res.sequenceEndTicks && expectTicks &&
                Math.abs(Number(res.sequenceEndTicks) - Number(expectTicks)) > Number(expectTicks) * 0.01) {
                log(`⚠ 时长校验偏差：序列 ${res.sequenceEndTicks} ticks，预期约 ${expectTicks} ticks。` +
                    `可能是源素材起始 tick 不为 0，请在 hostscript 的 sourceOffsetTicks 里校正。`);
                status('已落地，但时长有偏差（见日志）', 'warn');
            }

            if (res.clipsFailed > 0) {
                log(`⚠ 有 ${res.clipsFailed} 段子剪辑创建失败，前若干条：` +
                    JSON.stringify(res.failedDetail || []));
                log('若失败数量很多，说明当前 Premiere 版本对 createSubClip 支持不佳，建议改用「导出 EDL」→「导入 EDL」。');
            }
            if (res.markersAdded > 0) {
                log('提示：请在时间轴上逐个查看橙色标记，选中对应片段后右键 →「速度/持续时间」按标记建议值设置。' +
                    'Premiere 的插件 API（ExtendScript 与 UXP 均如此）无法直接修改片段速度，这一步只能手动完成。');
            }
        } catch (e) {
            setBusy(false);
            status('落地失败', 'err');
            log('applyEdit 失败: ' + e.message);
            log('建议改用「导出 EDL」→「导入 EDL」路径，兼容性更好。');
        }
    }

    // ------------------------------------------------------------------
    //  EDL
    // ------------------------------------------------------------------

    async function exportEdl() {
        if (!state.session) { status('请先分析', 'warn'); return; }
        const out = ($('edl-path').value || '').trim();
        if (!out) { status('请填写 EDL 输出路径', 'warn'); return; }

        setBusy(true, '正在生成 EDL…');
        try {
            const clipName = state.hostInfo && state.hostInfo.candidates && state.hostInfo.candidates[0]
                ? state.hostInfo.candidates[0].name : '';
            const r = await B.exportEdl(state.sessionPath, out, clipName,
                                        state.session.keep_ranges);
            setBusy(false);
            $('edl-path').value = r.edl_path;
            $('btn-import-edl').disabled = false;
            status(`EDL 已生成：${r.events} 条事件 / ${r.record_seconds}s`, 'ok');
            log(`EDL → ${r.edl_path}  events=${r.events} record=${r.record_frames}帧`);
        } catch (e) {
            setBusy(false);
            status('EDL 导出失败', 'err');
            log('EDL 导出失败: ' + e.message);
            if (e.detail) log(e.detail.split('\n').slice(-6).join('\n'));
            const hint = hintFor(e);
            if (hint) log(hint);
        }
    }

    async function importEdl() {
        const p = ($('edl-path').value || '').trim();
        if (!p) { status('请先导出或填写 EDL 路径', 'warn'); return; }
        setBusy(true, '正在导入 EDL…');
        try {
            const res = await jsx('importEdl', p);
            setBusy(false);
            status(`EDL 已导入，新建 ${res.newSequenceIds.length} 条序列`, 'ok');
            log('importEdl 成功: ' + JSON.stringify(res.newSequenceIds));
        } catch (e) {
            setBusy(false);
            status('EDL 导入失败', 'err');
            log('importEdl 失败: ' + e.message);
            log('可手动导入：Premiere → 文件 → 导入 → 选择该 .edl 文件。');
        }
    }

    // ------------------------------------------------------------------
    //  环境检测
    // ------------------------------------------------------------------

    async function checkEnv(silent) {
        status('正在检测环境…', 'busy');
        const lines = [];
        let ok = true;

        // 1) Node / CEP
        // 注意：CEP 11（PR 2021）内嵌的是 Chromium 74，不支持可选链与
        // 空值合并运算符。本文件其余地方也必须保持 Chromium 74 可解析的
        // 语法，否则整个面板直接白屏。
        const chromeVer = (window.navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
        lines.push(`Node ${process.versions.node} · Chromium ${chromeVer}`);

        // 2) Python
        const py = await B.detectPython(true);
        if (py && py.exe) {
            lines.push(`Python: ${py.exe} ${py.preArgs.join(' ')} → ${py.version}`);
        } else {
            ok = false;
            lines.push('Python: 未找到。请安装 Python 3.10+，或在下方手动指定解释器路径。');
            if (py && py.tried) lines.push('  已尝试: ' + py.tried.join(' / '));
        }

        // 3) 分析器目录
        const cliDir = B.getState().cliDir;
        if (cliDir) {
            lines.push(`分析器: ${cliDir}`);
        } else {
            ok = false;
            lines.push('分析器: 找不到 pr_cli.py 与 analyzer.py。请在下方指定分析器目录。');
        }

        // 4) Python 依赖（只检查插件路径必需的 numpy / cv2）
        if (py && py.exe) {
            const deps = await B.checkDeps();
            if (deps.ok) {
                lines.push('依赖: numpy / opencv 就绪');
                if (deps.optionalMissing && deps.optionalMissing.length) {
                    lines.push('  可选依赖未装: ' + deps.optionalMissing.join(', ') +
                               '（仅原独立版导出/界面需要，插件不影响使用）');
                }
            } else {
                ok = false;
                lines.push('必需依赖缺失: ' + (deps.missing && deps.missing.length
                    ? deps.missing.join(', ') : deps.error));
                lines.push('  修复: 在分析器目录执行  pip install numpy opencv-python');
            }
        }

        // 5) Premiere 侧能力
        try {
            const caps = await jsx('checkCapabilities');
            const c = caps.checks || {};
            lines.push(`Premiere ${caps.appVersion}: createSubClip=${yn(c.createSubClip)} ` +
                       `createNewSequenceFromClips=${yn(c.createNewSequenceFromClips)} ` +
                       `markers=${yn(c.markers)} importFiles=${yn(c.importFiles)}`);
            if (!c.createSubClip || !c.createNewSequenceFromClips) {
                lines.push('  ⚠ 关键 API 缺失，「落地到 Premiere」可能失败，建议改用 EDL 路径。');
            }
            lines.push(`  QE DOM=${yn(c.qeDom)}（本插件不依赖，仅供参考）`);
        } catch (e) {
            ok = false;
            lines.push('Premiere: 无法通信 —— ' + e.message);
            lines.push('  请确认本面板是通过 Premiere 的「窗口 → 扩展」打开的，而非在浏览器里直接打开 index.html。');
        }

        $('env-report').innerHTML = lines.map(l =>
            l.startsWith('  ') ? `<span class="muted">${esc(l)}</span>` : esc(l)
        ).join('<br>');
        lines.forEach(l => log('env| ' + l));

        status(ok ? '环境就绪' : '环境存在问题（详见设置页）', ok ? 'ok' : 'err');
        if (!ok && !silent) $('sec-settings').open = true;
        return ok;
    }

    const yn = v => v ? '✓' : '✗';
    const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

    /**
     * 把桥接层的错误码翻译成「下一步该做什么」。
     * 环境类错误（缺 Python / 缺 pr_cli.py）与数据类错误（素材读不了）
     * 的修复动作完全不同，混在一起报只会让用户无从下手。
     */
    function hintFor(e) {
        if (!e || !e.code || !B || !B.CODE) return '';
        const C = B.CODE;
        if (e.code === C.NO_PYTHON) return '→ 请在「设置」里指定 Python 解释器路径，或安装 Python 3.10+ 后重试。';
        if (e.code === C.NO_CLI) return '→ 请在「设置」里把「分析器目录」指向 pr_cli.py 所在文件夹。';
        if (e.code === C.TIMEOUT) return '→ 可在 ~/.arknight-pr/config.json 里调大 timeoutMs，或先用更短的素材试跑。';
        if (e.code === C.NO_RESULT) return '→ Python 异常退出。请把上方 stderr 末尾内容反馈给开发者。';
        if (e.code === C.SPAWN_FAILED) return '→ Python 启动失败。请在「设置」里核对解释器路径是否有效。';
        return '';
    }

    /** 分析时长上限，0 或未配置表示不限时。 */
    function timeoutOpt() {
        const ms = Number((B.getConfig() || {}).timeoutMs) || 0;
        return ms > 0 ? { timeoutMs: ms } : {};
    }

    // ------------------------------------------------------------------
    //  初始化
    // ------------------------------------------------------------------

    function bindEvents() {
        $('btn-pick').addEventListener('click', pickFromPR);
        $('btn-analyze').addEventListener('click', startAnalyze);
        $('btn-cancel').addEventListener('click', cancelAnalyze);
        $('btn-apply').addEventListener('click', applyToPremiere);
        $('btn-edl').addEventListener('click', exportEdl);
        $('btn-import-edl').addEventListener('click', importEdl);
        $('btn-check').addEventListener('click', () => checkEnv(false));
        $('btn-recompute').addEventListener('click', () => recompute(true));

        $('btn-save-cfg').addEventListener('click', () => {
            const py = ($('s-python').value || '').trim();
            const dir = ($('s-clidir').value || '').trim();
            B.saveConfig({ pythonPath: py || null, cliDir: dir || null });
            // 重新解析，让新配置立刻生效
            B.getState().python = null;
            B.init(cs.getSystemPath(CSInterface.EXTENSION));
            $('s-python').value = B.getConfig().pythonPath || '';
            $('s-clidir').value = B.getConfig().cliDir || '';
            log('设置已保存到 ' + B.paths.CONFIG_PATH);
            checkEnv(true);
        });

        // 单段模式按钮
        document.querySelectorAll('.seg-btn').forEach(b => {
            b.addEventListener('click', () => {
                if (state.selectedPauseId === null) { status('请先在时间轴上选中一个暂停段', 'warn'); return; }
                state.timeline.setPauseMode(state.selectedPauseId, b.dataset.mode);
            });
        });
        // 批量模式按钮
        document.querySelectorAll('.batch-btn').forEach(b => {
            b.addEventListener('click', () => {
                if (!state.session) { status('请先分析', 'warn'); return; }
                state.timeline.setPauseMode(null, b.dataset.mode);
            });
        });

        $('video-path').addEventListener('change', e => {
            const v = e.target.value.trim();
            if (v) { state.videoPath = v; $('edl-path').value = B.defaultEdlPath(v); $('btn-analyze').disabled = false; }
        });

        window.addEventListener('resize', () => state.timeline.resize());
    }

    async function init() {
        // 最常见的失败模式：manifest 漏了 --enable-nodejs / --mixed-context，
        // 或者用户在浏览器里直接打开了 index.html。此时 bridge.js 加载失败，
        // 必须给出可操作的提示，而不是让面板静默变成一片空白。
        if (!B) {
            status('Node.js 不可用', 'err');
            $('host-info').textContent = '无法加载 Node 桥接层，插件功能不可用。';
            log('致命错误：window.ArknightBridge 未定义。请检查：');
            log('  1. CSXS/manifest.xml 的 CEFCommandLine 是否含 --enable-nodejs 与 --mixed-context');
            log('  2. 面板是否通过 Premiere 的「窗口 → 扩展」打开（在浏览器里直接打开 index.html 不行）');
            log('  3. 改动 manifest 后是否重启了 Premiere');
            return;
        }

        const extDir = cs.getSystemPath(CSInterface.EXTENSION);
        B.init(extDir);

        // 回填已保存的配置
        const cfg = B.getConfig();
        $('s-python').value = cfg.pythonPath || '';
        $('s-clidir').value = cfg.cliDir || '';

        state.timeline = new window.ArknightTimeline($('timeline'));
        state.timeline.onSelect = (id, seg) => updateSelectedInfo(id, seg);
        state.timeline.onChange = onTimelineChange;

        bindEvents();
        log('面板已加载，扩展目录: ' + extDir);

        const ok = await checkEnv(true);
        if (ok) {
            status('环境就绪，请从 Premiere 获取素材', 'ok');
            // 自动读一次宿主信息，多数情况下用户已经选中了素材
            pickFromPR().catch(() => { });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
