/**
 * bridge.js —— Node.js 侧：负责启动 Python 分析进程并与之通信
 *
 * 为什么用 child_process 而不是 HTTP 服务：
 *   CEP 自带 Node.js（CEP 11 → Node 12，CEP 12 → Node 17.7.1），
 *   直接 spawn 子进程即可。相比常驻 HTTP 服务的优势：
 *     - 不占端口、不触发 Windows 防火墙弹窗
 *     - 进程生命周期跟随一次分析，崩溃不会留下僵尸服务
 *     - 无需处理并发请求与会话隔离
 *
 * 通信协议：Python 侧 stdout 输出 NDJSON（每行一个 JSON），
 *   {"type":"progress",...} / {"type":"result",...} / {"type":"error",...}
 *   诊断信息走 stderr，二者绝不混流。
 *
 * 兼容性：本文件只使用 Node 12 与 Node 17 都稳定支持的 API，
 *   刻意避开 fs.promises.rm(14.14+)、AbortController(15+) 等新特性。
 */
(function () {
    'use strict';

    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const { spawn, execFile } = require('child_process');
    const { StringDecoder } = require('string_decoder');

    // ------------------------------------------------------------------
    //  路径与状态
    // ------------------------------------------------------------------

    // 配置与会话放在用户主目录而非扩展目录：
    // 扩展可能被装到 Program Files（只读），主目录一定可写。
    const HOME_DIR = path.join(os.homedir(), '.arknight-pr');
    const SESSION_DIR = path.join(HOME_DIR, 'sessions');
    const PAYLOAD_DIR = path.join(HOME_DIR, 'payload');
    const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

    const state = {
        extDir: '',        // 扩展安装目录，由 main.js 注入
        cliDir: '',        // pr_cli.py 所在目录
        cliPath: '',       // pr_cli.py 绝对路径
        python: null,      // { exe, preArgs, version }
        child: null,       // 正在运行的分析进程，供取消用
        config: {}
    };

    /**
     * 统一错误码。
     *
     * 面板侧需要区分「环境问题」和「数据问题」，否则只能把同一句
     * traceback 甩给用户 —— 而这两类问题的修复动作完全不同
     * （装 Python / 重新选素材）。调用方通过 err.code 取。
     */
    const CODE = {
        NO_PYTHON: 'NO_PYTHON',         // 没有可用的 Python 解释器
        NO_CLI: 'NO_CLI',               // 找不到 pr_cli.py
        SPAWN_FAILED: 'SPAWN_FAILED',   // 子进程起不来
        BUSY: 'BUSY',                   // 前一任务仍在运行或清理
        CANCELLED: 'CANCELLED',         // 用户主动取消
        TIMEOUT: 'TIMEOUT',             // 超时被终止
        CLI_ERROR: 'CLI_ERROR',         // Python 返回 {"type":"error"}
        NO_RESULT: 'NO_RESULT'          // 进程退出但没给结果
    };

    /** 构造带错误码的 Error。 */
    function fail(code, message, extra) {
        const e = new Error(message);
        e.code = code;
        if (extra) { Object.assign(e, extra); }
        return e;
    }

    // 清理完成前保留任务所有权；原因、定时器与进程句柄均归属于任务。
    let activeTask = null;
    const STOP_WAIT_MS = 2000;

    function busyError() {
        return fail(CODE.BUSY, '上一任务仍在运行或清理，请稍后重试');
    }

    // POSIX 使用独立进程组，Windows 使用 taskkill /T /F（无 shell）。
    // 强制终止整个树，避免父进程先退出后无法再找到它的后代。
    function killTree(child, done) {
        if (!child.pid) { done(); return; }
        if (process.platform === 'win32') {
            try {
                execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
                    ['/PID', String(child.pid), '/T', '/F'],
                    { windowsHide: true, timeout: STOP_WAIT_MS }, (err) => {
                        if (err) { try { child.kill('SIGKILL'); } catch (e) { } }
                        done();
                    });
            } catch (e) {
                try { child.kill('SIGKILL'); } catch (ignored) { }
                done();
            }
        } else {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (e) { try { child.kill('SIGKILL'); } catch (ignored) { } }
            done();
        }
    }

    function ensureDirs() {
        [HOME_DIR, SESSION_DIR, PAYLOAD_DIR].forEach(d => {
            try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 已存在 */ }
        });
    }

    function init(extDir) {
        state.extDir = extDir || '';
        ensureDirs();
        state.config = loadConfig();
        state.python = null;
        state.cliDir = resolveCliDir();
        state.cliPath = state.cliDir ? path.join(state.cliDir, 'pr_cli.py') : '';
        return state;
    }

    // ------------------------------------------------------------------
    //  配置持久化
    // ------------------------------------------------------------------

    function loadConfig() {
        try {
            // install.ps1（PS 5.1）写出的文件可能带 UTF-8 BOM，必须剥掉，
            // 否则 JSON.parse 抛错被 catch 吞掉，用户配置被静默忽略
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            return JSON.parse(raw.replace(/^\uFEFF/, ''));
        } catch (e) {
            return {};
        }
    }

    function saveConfig(patch) {
        const next = Object.assign({}, state.config, patch || {});
        try {
            ensureDirs();
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
            state.config = next;
            if (patch && Object.prototype.hasOwnProperty.call(patch, 'pythonPath')) state.python = null;
            return true;
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    //  定位 Python 与 pr_cli.py
    // ------------------------------------------------------------------

    /**
     * 候选目录按优先级排列。
     *
     * 分析器是**外部项目**，位置不固定（本仓库不含其代码），所以只能多猜几个常见位置；
     * 全部落空时面板会提示用户手动指定。真正的兜底是下面第 1 条和第 4 条。
     *   1. 用户在面板里显式配置的 cliDir
     *   2. 与分析器平级存放时的常见布局：<扩展目录>/../arknight-auto-editing-main
     *   3. 扩展目录自身（打包发布时可能把分析器一起放进扩展）
     *   4. 环境变量 ARKNIGHT_ANALYZER_DIR
     */
    function resolveCliDir() {
        const candidates = [];
        if (state.config.cliDir) candidates.push(state.config.cliDir);
        if (state.extDir) {
            candidates.push(path.join(state.extDir, '..', 'backend'));
            candidates.push(path.join(state.extDir, 'backend'));
            candidates.push(path.join(state.extDir, '..', 'arknight-auto-editing-main'));
            candidates.push(path.join(state.extDir, '..', 'analyzer'));
            candidates.push(state.extDir);
            candidates.push(path.join(state.extDir, 'analyzer'));
        }
        if (process.env.ARKNIGHT_ANALYZER_DIR) candidates.push(process.env.ARKNIGHT_ANALYZER_DIR);

        for (const dir of candidates) {
            try {
                if (dir && fs.existsSync(path.join(dir, 'pr_cli.py')) &&
                    fs.existsSync(path.join(dir, 'analyzer.py'))) {
                    return path.resolve(dir);
                }
            } catch (e) { /* 继续尝试下一个 */ }
        }
        return '';
    }

    /** 探测一个候选 Python 是否可用，返回版本号或 null。 */
    function probePython(exe, preArgs) {
        return new Promise(resolve => {
            let out = '';
            let child;
            try {
                child = execFile(exe, (preArgs || []).concat(['--version']),
                    { windowsHide: true, timeout: 8000 },
                    (err, stdout, stderr) => {
                        out = String(stdout || stderr || '').trim();
                        if (err || !out) { resolve(null); return; }
                        const m = out.match(/Python\s+(\d+)\.(\d+)/);
                        if (!m) { resolve(null); return; }
                        // analyzer 用了 dataclass / f-string / 类型标注，需要 3.10+
                        const major = parseInt(m[1], 10), minor = parseInt(m[2], 10);
                        if (major < 3 || (major === 3 && minor < 10)) {
                            resolve({ exe, preArgs: preArgs || [], version: out, tooOld: true });
                            return;
                        }
                        resolve({ exe, preArgs: preArgs || [], version: out, tooOld: false });
                    });
            } catch (e) {
                resolve(null);
                return;
            }
            // execFile 的 timeout 在个别老 Node 上不可靠，加一道保险
            setTimeout(() => { try { child.kill(); } catch (e) { } }, 9000);
        });
    }

    /** 依次尝试配置值、py 启动器、python、python3，取第一个可用者。 */
    async function detectPython(force) {
        if (state.python && !force && (!state.config.pythonPath || state.python.exe === state.config.pythonPath)) return state.python;

        const candidates = [];
        if (state.config.pythonPath) {
            candidates.push({ exe: state.config.pythonPath, preArgs: [] });
        }
        // Windows 官方启动器，能自动挑选已安装的 3.x
        if (!state.config.pythonPath) {
            if (process.platform === 'win32') candidates.push({ exe: 'py', preArgs: ['-3'] });
            candidates.push({ exe: 'python', preArgs: [] });
            candidates.push({ exe: 'python3', preArgs: [] });
        }

        const tried = [];
        for (const c of candidates) {
            const r = await probePython(c.exe, c.preArgs);
            if (!r) { tried.push(c.exe + ' → 不可用'); continue; }
            if (r.tooOld) { tried.push(c.exe + ' → ' + r.version + '（需 3.10+）'); continue; }
            state.python = r;
            return r;
        }
        state.python = null;
        return { exe: null, version: '', tried };
    }

    /**
     * 校验分析器依赖。
     *
     * 只把「插件路径真正需要」的列为必需：
     *   numpy / cv2  —— analyzer.py 的模板匹配与帧差计算离不开
     * imageio 与 PIL 属于**可选**：
     *   imageio 只用于 analyzer.export_video 的兜底写入分支，
     *           而插件方案由 Premiere 负责剪辑，Python 侧从不导出视频；
     *   PIL     只服务于原 Tkinter 界面（preview_player / timeline_widget），
     *           本扩展的时间轴是 canvas 画的。
     * 把它们列为必需会在只装了 numpy+opencv 的环境里误报，吓退用户。
     */
    async function checkDeps() {
        if (!state.python) return { ok: false, error: '未检测到 Python' };
        const py = state.python;
        return new Promise(resolve => {
            // 真正导入才能发现 DLL/ABI 损坏，find_spec 只能说明文件存在。
            const code = 'import importlib\n' +
                'def miss(ms):\n' +
                '    failed = []\n' +
                '    for m in ms:\n' +
                '        try: importlib.import_module(m)\n' +
                '        except Exception: failed.append(m)\n' +
                '    return failed\n' +
                'print("MISSING:"+",".join(miss(["numpy","cv2"])))\n' +
                'print("OPTIONAL_MISSING:"+",".join(miss(["PIL","imageio"])))\n';
            execFile(py.exe, py.preArgs.concat(['-c', code]),
                { windowsHide: true, timeout: 20000 },
                (err, stdout, stderr) => {
                    if (err) {
                        resolve({ ok: false, error: String(stderr || err.message).slice(0, 400) });
                        return;
                    }
                    const text = String(stdout);
                    const m = text.match(/MISSING:(.*)/);
                    const o = text.match(/OPTIONAL_MISSING:(.*)/);
                    const parse = x => (x && x[1].trim()) ? x[1].trim().split(',') : [];
                    const missing = parse(m);
                    resolve({
                        ok: missing.length === 0,
                        missing,
                        optionalMissing: parse(o)
                    });
                });
        });
    }

    // ------------------------------------------------------------------
    //  运行 CLI
    // ------------------------------------------------------------------

    /**
     * 执行 pr_cli.py 的一条子命令，流式回调进度。
     * @param {string[]} args  子命令与参数
     * @param {object}   opts  { onProgress(msg), onLog(text), timeoutMs }
     *                         timeoutMs <= 0 或省略表示不限时
     */
    function runCli(args, opts) {
        opts = opts || {};
        return new Promise((resolve, reject) => {
            if (activeTask) { reject(busyError()); return; }
            if (!state.python) {
                reject(fail(CODE.NO_PYTHON, '未检测到可用的 Python，请先在设置里指定解释器路径'));
                return;
            }
            if (!state.cliPath || !fs.existsSync(state.cliPath)) {
                reject(fail(CODE.NO_CLI, '找不到 pr_cli.py。请在设置里指定分析器目录（当前: ' +
                    (state.cliDir || '未找到') + '）'));
                return;
            }

            const py = state.python;
            const full = py.preArgs.concat([state.cliPath], args);
            let child;
            try {
                child = spawn(py.exe, full, {
                    cwd: state.cliDir, windowsHide: true,
                    detached: process.platform !== 'win32'
                });
            } catch (e) {
                reject(fail(CODE.SPAWN_FAILED, '无法启动 Python: ' + e.message));
                return;
            }
            const task = { child, reason: '', stop: null };
            activeTask = task;
            state.child = child;

            let settled = false;
            let timer = null, stopTimer = null;
            let closed = false, treeDone = false;
            const finish = (fn, value) => {
                if (settled) { return; }
                settled = true;
                if (timer) { clearTimeout(timer); }
                if (stopTimer) { clearTimeout(stopTimer); }
                if (activeTask === task) {
                    activeTask = null;
                    if (state.child === child) state.child = null;
                }
                fn(value);
            };

            const timeoutMs = Number(opts.timeoutMs) || 0;
            const finishStopped = () => {
                finish(reject, task.reason === 'cancel'
                    ? fail(CODE.CANCELLED, '分析已取消')
                    : fail(CODE.TIMEOUT, '分析超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒），已请求终止进程树'));
            };
            task.stop = reason => {
                if (settled || task.reason) return;
                task.reason = reason;
                if (timer) clearTimeout(timer);
                // close 可能永远不来（后代持有管道、运行时异常等）。
                stopTimer = setTimeout(() => {
                    child.stdout.destroy();
                    child.stderr.destroy();
                    if (child.stdin) child.stdin.destroy();
                    child.unref();
                    finishStopped();
                }, STOP_WAIT_MS + 500);
                killTree(child, () => {
                    if (settled) return;
                    treeDone = true;
                    if (closed) finishStopped();
                });
            };
            if (timeoutMs > 0) {
                timer = setTimeout(() => task.stop('timeout'), timeoutMs);
            }

            const outDec = new StringDecoder('utf8');
            const errDec = new StringDecoder('utf8');
            let outBuf = '', errTail = '';
            let result = null, cliError = null;

            // stdout 的最后一行可能不带换行符，close 时需再冲一次
            const drain = (final) => {
                let i;
                while ((i = outBuf.indexOf('\n')) >= 0) {
                    handleLine(outBuf.slice(0, i));
                    outBuf = outBuf.slice(i + 1);
                }
                if (final && outBuf.trim()) { handleLine(outBuf); outBuf = ''; }
            };

            const handleLine = (line) => {
                line = line.trim();
                if (settled || task.reason || !line || line[0] !== '{') return;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { return; }
                if (msg.type === 'progress') {
                    if (opts.onProgress) opts.onProgress(msg);
                } else if (msg.type === 'result') {
                    result = msg;
                } else if (msg.type === 'error') {
                    cliError = msg;
                }
            };

            child.stdout.on('data', d => {
                if (settled || task.reason) return;
                outBuf += outDec.write(d); drain(false);
            });
            child.stderr.on('data', d => {
                if (settled || task.reason) return;
                const s = errDec.write(d);
                // 只保留尾部若干字符用于报错，避免长堆栈撑爆内存
                errTail = (errTail + s).slice(-4000);
                if (opts.onLog) opts.onLog(s);
            });
            child.on('error', e => {
                if (task.reason || settled) return;
                finish(reject, fail(CODE.SPAWN_FAILED, 'Python 进程启动失败: ' + e.message));
            });
            child.on('close', code => {
                if (settled) return;
                closed = true;
                if (task.reason) {
                    if (treeDone) finishStopped();
                    return;
                }
                outBuf += outDec.end();
                errTail += errDec.end();
                drain(true);

                // 末行进度回调也可能调用 cancel。
                if (task.reason) {
                    if (treeDone) finishStopped();
                    return;
                }
                if (cliError) {
                    finish(reject, fail(CODE.CLI_ERROR, cliError.message || '分析失败',
                        { detail: cliError.detail || '', backendCode: cliError.code || '' }));
                    return;
                }
                if (!result) {
                    finish(reject, fail(CODE.NO_RESULT,
                        'Python 退出(code=' + code + ')但未返回结果。\n' +
                        (errTail ? 'stderr 末尾:\n' + errTail.slice(-1200) : ''),
                        { stderrTail: errTail.slice(-4000) }));
                    return;
                }
                finish(resolve, result);
            });
        });
    }

    /** 取消正在运行的分析。 */
    function cancel() {
        if (activeTask) {
            activeTask.stop('cancel');
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    //  会话与载荷文件
    // ------------------------------------------------------------------

    /** 由视频路径派生稳定的会话文件名，重复分析会覆盖同一份。 */
    function sessionPathFor(videoPath) {
        const base = path.basename(videoPath).replace(/[^\w.\-]+/g, '_');
        let h = 0;
        const s = String(videoPath);
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
        return path.join(SESSION_DIR, base + '_' + (h >>> 0).toString(16) + '.json');
    }

    /**
     * 把对象写成临时 JSON 文件，返回路径。
     * 两个用途：
     *   1. 给 pr_cli.py 传大负载（绕过 Windows ~32KB 命令行长度上限）
     *   2. 给 hostscript.jsx 传负载（绕过 evalScript 的长度与转义限制）
     */
    function writePayload(name, obj, taskDir) {
        ensureDirs();
        const p = path.join(taskDir || PAYLOAD_DIR, name);
        // Node 默认写 UTF-8 无 BOM，JSX 侧已做 BOM 兜底剥离
        fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
        return p;
    }

    function readJsonFile(p) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    function fileExists(p) {
        try { return !!p && fs.existsSync(p); } catch (e) { return false; }
    }

    // ------------------------------------------------------------------
    //  业务命令封装
    // ------------------------------------------------------------------

    function probe(videoPath) {
        return runCli(['probe', '--video', videoPath]);
    }

    function suggestContentRect(videoPath, opts) {
        return runCli(['suggest-content-rect', '--video', videoPath], opts || {})
            .then(r => r.suggestion);
    }

    // 参数生命周期覆盖整个任务（包括终止等待），不与 JSX 的载荷共用文件。
    function withTaskPayloads(run) {
        if (activeTask) return Promise.reject(busyError());
        let dir;
        const cleanup = () => {
            if (!dir) return;
            try {
                fs.readdirSync(dir).forEach(name => fs.unlinkSync(path.join(dir, name)));
                fs.rmdirSync(dir);
            } catch (e) { /* 文件被外部占用时保留，仅影响本任务 */ }
        };
        try {
            ensureDirs();
            dir = fs.mkdtempSync(path.join(PAYLOAD_DIR, 'task-'));
            return Promise.resolve(run((name, obj) => writePayload(name, obj, dir))).then(
                result => { cleanup(); return result; },
                error => { cleanup(); throw error; });
        } catch (e) {
            cleanup();
            return Promise.reject(e);
        }
    }

    function analyze(videoPath, params, opts) {
        return withTaskPayloads(write => {
            const session = sessionPathFor(videoPath);
            return runCli([
                'analyze', '--video', videoPath, '--session-out', session,
                '--params', write('params.json', params || {})
            ], opts || {}).then(r => {
                r.sessionPath = session;
                return r;
            });
        });
    }

    /**
     * 面板调参或拖拽后重算，不重新解码视频。
     * overrides 一律走文件，因为其中含每段的 local_del_mask 数组，
     * 真实录像序列化后可达数百 KB。
     */
    function recompute(sessionPath, overrides, params, opts) {
        return withTaskPayloads(write => {
            const args = ['ranges', '--session', sessionPath,
                '--overrides', write('overrides.json', overrides || {})];
            if (params) args.push('--session-params', write('params.json', params));
            return runCli(args, opts || {}).then(r => {
                r.sessionPath = sessionPath;
                return r;
            });
        });
    }

    function exportEdl(sessionPath, outPath, clipName, keepRanges) {
        return withTaskPayloads(write => {
            const args = ['export-edl', '--session', sessionPath, '--out', outPath];
            if (clipName) args.push('--clip-name', clipName);
            if (keepRanges) {
                args.push('--overrides', write('overrides.json', { keep_ranges: keepRanges }));
            }
            return runCli(args);
        });
    }

    /** EDL 默认输出路径：与源视频同目录，加 _autoedit 后缀。 */
    function defaultEdlPath(videoPath) {
        const dir = path.dirname(videoPath);
        const ext = path.extname(videoPath);
        const base = path.basename(videoPath, ext);
        return path.join(dir, base + '_autoedit.edl');
    }

    // ------------------------------------------------------------------

    window.ArknightBridge = {
        init,
        detectPython,
        checkDeps,
        resolveCliDir,
        cancel,
        runCli,
        probe,
        suggestContentRect,
        analyze,
        recompute,
        exportEdl,
        defaultEdlPath,
        writePayload,
        readJsonFile,
        fileExists,
        sessionPathFor,
        saveConfig,
        CODE,
        getState: () => state,
        getConfig: () => state.config,
        getRuntimeConfig: () => ({ extDir: state.extDir, cliDir: resolveCliDir(),
            pythonPath: state.config.pythonPath || '', backendDir: state.config.backendDir || state.config.cliDir || '' }),
        paths: { HOME_DIR, SESSION_DIR, PAYLOAD_DIR, CONFIG_PATH }
    };
})();
