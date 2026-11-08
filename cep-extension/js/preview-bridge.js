/* Node 12 / Chromium 74. One persistent decoder per source, isolated channels. */
(function () {
    'use strict';
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const cp = require('child_process');
    const StringDecoder = require('string_decoder').StringDecoder;
    const workers = new Map(), channels = new Map();
    let serial = 0, requestSerial = 0;

    function remove(dir) {
        if (!dir || !fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(name => fs.unlinkSync(path.join(dir, name)));
        fs.rmdirSync(dir);
    }
    function error(code, message) { const e = new Error(message); e.code = code; return e; }
    function locate(config) {
        const dirs = [config.backendDir, config.cliDir];
        if (config.extDir) dirs.push(path.join(config.extDir, 'backend'), path.join(config.extDir, '..', 'backend'));
        dirs.push(path.resolve(__dirname, '../../backend'));
        for (const dir of dirs) {
            if (dir && fs.existsSync(path.join(dir, 'preview_server.py'))) return path.join(dir, 'preview_server.py');
        }
        throw error('NO_PREVIEW', 'Cannot locate backend/preview_server.py');
    }
    function stop(worker) {
        if (worker.stopping) return worker.stopping;
        if (workers.get(worker.key) === worker) workers.delete(worker.key);
        worker.dead = true;
        worker.stopping = worker.ready.catch(() => {}).then(() => new Promise(resolve => {
            const child = worker.child;
            const cleanup = () => {
                try { remove(worker.dir); resolve(); }
                catch (e) { resolve(); } // Antivirus may temporarily hold a JPEG; retry below on close.
            };
            if (!child || !child.pid || worker.exited) { cleanup(); return; }
            let finished = false;
            const done = () => { if (finished) return; finished = true; clearTimeout(timer); cleanup(); };
            const timer = setTimeout(() => {
                child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); done();
            }, 3000);
            child.once('close', done);
            if (process.platform === 'win32') {
                cp.execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
                    ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, err => {
                        if (err) { try { child.kill('SIGKILL'); } catch (ignored) {} }
                    });
            } else {
                try { process.kill(-child.pid, 'SIGKILL'); }
                catch (e) { try { child.kill('SIGKILL'); } catch (ignored) {} }
            }
        }));
        return worker.stopping;
    }
    function makeWorker(video) {
        const worker = { key: video, members: new Map(), closing: new Map(), dead: false, child: null, dir: null };
        workers.set(video, worker);
        function fatal(e) {
            if (worker.dead) return;
            worker.members.forEach(member => member.report(e));
            stop(worker);
        }
        worker.ready = Promise.resolve().then(async () => {
            const bridge = window.ArknightBridge;
            const script = locate(bridge.getRuntimeConfig());
            const py = await bridge.detectPython();
            if (!py.exe) throw error('NO_PYTHON', 'Configured Python unavailable: ' + (py.tried || []).join('; '));
            if (worker.dead) return;
            worker.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arknight-preview-'));
            const child = cp.spawn(py.exe, py.preArgs.concat(['-u', script, '--video', video, '--cache', worker.dir]),
                { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
            worker.child = child;
            const decoder = new StringDecoder('utf8');
            let buffer = '', stderr = '';
            child.stdout.on('data', data => {
                buffer += decoder.write(data);
                let index;
                while ((index = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
                    let msg;
                    try { msg = JSON.parse(line); } catch (e) { continue; }
                    if (msg.type === 'closed' && worker.closing.has(msg.channel)) {
                        worker.closing.get(msg.channel)(); worker.closing.delete(msg.channel);
                    }
                    if (worker.dead) continue;
                    if (msg.type === 'fatal') { fatal(error(msg.code, msg.message)); continue; }
                    const member = worker.members.get(msg.channel);
                    if (!member || member.closed || msg.requestId !== member.latest) continue;
                    if (msg.type === 'frame' && member.onFrame) member.onFrame({ frame: msg.frame, path: msg.path,
                        width: msg.width, height: msg.height, sourceWidth: msg.sourceWidth,
                        sourceHeight: msg.sourceHeight, fps: msg.fps, totalFrames: msg.totalFrames,
                        metadataStatus: msg.metadataStatus, fpsStatus: msg.fpsStatus, requestId: msg.requestId });
                    if (msg.type === 'error') member.report(Object.assign(error(msg.code, msg.message), { requestId: msg.requestId }));
                }
                if (buffer.length > 65536) fatal(error('PROTOCOL', 'Preview response too large'));
            });
            child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
            child.stdin.on('error', e => fatal(error('PIPE_ERROR', e.message)));
            child.on('error', e => fatal(error('SPAWN_FAILED', e.message)));
            child.on('close', code => {
                worker.exited = true;
                worker.closing.forEach(resolve => resolve()); worker.closing.clear();
                if (!worker.dead) fatal(error('PREVIEW_EXIT', 'Preview exited (' + code + '): ' + stderr));
                try { remove(worker.dir); } catch (e) {}
            });
        });
        worker.ready.catch(fatal);
        return worker;
    }
    function create(videoPath, options) {
        const opts = options || {};
        const channel = opts.channel == null ? 'auto' + (++serial) : String(opts.channel);
        if (channels.has(channel)) channels.get(channel).close();
        const key = path.resolve(videoPath);
        const worker = workers.get(key) || makeWorker(key);
        const id = 'c' + (++serial);
        const member = { closed: false, latest: 0, onFrame: opts.onFrame,
            report: e => { if (!member.closed && opts.onError) opts.onError(e); } };
        worker.members.set(id, member);
        let closing;
        function send(msg) {
            worker.ready.then(() => {
                if (!worker.dead && worker.child) worker.child.stdin.write(JSON.stringify(msg) + '\n');
            }).catch(() => {});
        }
        const api = {
            seek: frame => {
                const requestId = ++requestSerial;
                member.latest = requestId;
                if (member.closed) return requestId;
                if (!Number.isSafeInteger(frame) || frame < 0) {
                    member.report(Object.assign(error('FRAME_ERROR', 'Frame must be a nonnegative integer'), { requestId }));
                    return requestId;
                }
                // Coalesce requests while Python detection/startup is pending.
                worker.ready.then(() => {
                    if (!member.closed && member.latest === requestId && !worker.dead) {
                        worker.child.stdin.write(JSON.stringify({ op: 'seek', channel: id, frame, requestId }) + '\n');
                    }
                }).catch(() => {});
                return requestId;
            },
            close: () => {
                if (closing) return closing;
                member.closed = true;
                worker.members.delete(id);
                if (channels.get(channel) === api) channels.delete(channel);
                if (!worker.members.size) closing = stop(worker);
                else {
                    closing = new Promise(resolve => {
                        const timer = setTimeout(() => { worker.closing.delete(id); resolve(); }, 3000);
                        worker.closing.set(id, () => { clearTimeout(timer); resolve(); });
                    });
                    send({ op: 'close', channel: id, requestId: ++requestSerial });
                }
                return closing;
            }
        };
        channels.set(channel, api);
        return api;
    }
    // Proxies are opt-in: call only after native HTML video reports unsupported media.
    // Each call owns a lease; cancel/cleanup never cancels another consumer's lease.
    const proxies = new Map();
    const proxyLeases = new Set();
    const proxyProfile = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
        '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart'];

    function ensureProxy(videoPath, options) {
        const opts = options || {};
        let job, released = false, settled = false, rejectLease, cleanupPromise;
        function release() {
            if (cleanupPromise) return cleanupPromise;
            released = true;
            proxyLeases.delete(release);
            if (!settled) { settled = true; rejectLease(error('CANCELLED', 'Proxy request cancelled')); }
            if (!job || --job.refs > 0) { cleanupPromise = Promise.resolve(); return cleanupPromise; }
            if (proxies.get(job.key) === job) proxies.delete(job.key);
            job.cancelled = true;
            if (job.child && !job.exited) {
                if (process.platform === 'win32') {
                    cp.execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
                        ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, err => {
                            if (err) { try { job.child.kill('SIGKILL'); } catch (ignored) {} }
                        });
                } else {
                    try { process.kill(-job.child.pid, 'SIGKILL'); }
                    catch (e) { try { job.child.kill('SIGKILL'); } catch (ignored) {} }
                }
            }
            cleanupPromise = job.promise.catch(() => {}).then(() => { remove(job.dir); });
            return cleanupPromise;
        }
        const promise = new Promise((resolve, reject) => {
            rejectLease = reject;
            Promise.resolve().then(() => {
                if (released) return;
                const source = fs.realpathSync(videoPath), stat = fs.statSync(source);
                if (!stat.isFile()) throw error('INVALID_MEDIA', 'Proxy source is not a file');
                const executable = opts.ffmpegPath || 'ffmpeg';
                const fingerprint = require('crypto').createHash('sha256').update(JSON.stringify([
                    source, stat.size, stat.mtimeMs, stat.ctimeMs, proxyProfile, executable
                ])).digest('hex');
                job = proxies.get(fingerprint);
                const cached = !!job;
                if (!job) {
                    job = { key: fingerprint, refs: 0, cancelled: false, child: null, exited: false };
                    proxies.set(fingerprint, job);
                    job.promise = Promise.resolve().then(() => {
                        if (job.cancelled) throw error('CANCELLED', 'Proxy request cancelled');
                        job.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arknight-proxy-'));
                        job.path = path.join(job.dir, fingerprint + '.mp4');
                        const partial = path.join(job.dir, 'partial.mp4');
                        return new Promise((done, fail) => {
                            let tail = '';
                            const child = cp.spawn(executable, ['-hide_banner', '-nostdin', '-y', '-i', source]
                                .concat(proxyProfile, [partial]),
                            { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
                            job.child = child;
                            child.stderr.on('data', data => { tail = (tail + data.toString()).slice(-4000); });
                            child.on('error', e => fail(error(e.code === 'ENOENT' ? 'NO_FFMPEG' : 'PROXY_FAILED',
                                e.code === 'ENOENT' ? '未找到 FFmpeg。请安装 FFmpeg 并加入 PATH，或设置 opts.ffmpegPath；不会自动下载。' : e.message)));
                            child.on('close', code => {
                                job.exited = true;
                                if (job.cancelled) { fail(error('CANCELLED', 'Proxy request cancelled')); return; }
                                if (code !== 0) { fail(error('PROXY_FAILED', 'FFmpeg failed: ' + tail)); return; }
                                try {
                                    const current = fs.statSync(source);
                                    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs)
                                        throw error('MEDIA_CHANGED', 'Source media changed during proxy generation');
                                    if (!fs.statSync(partial).size) throw error('PROXY_FAILED', 'Empty proxy');
                                    fs.renameSync(partial, job.path);
                                    done();
                                } catch (e) { fail(e); }
                            });
                        });
                    }).catch(e => {
                        if (proxies.get(fingerprint) === job) proxies.delete(fingerprint);
                        remove(job.dir);
                        throw e;
                    });
                }
                job.refs++;
                return job.promise.then(() => {
                    if (released) return;
                    settled = true;
                    resolve({ path: job.path, fingerprint, cached, videoCodec: 'h264', audioCodec: 'aac',
                        cleanup: release });
                });
            }).catch(e => {
                if (!settled) { settled = true; reject(e); }
                release().catch(() => {});
            });
        });
        promise.cancel = release;
        promise.cleanup = release;
        release.source = path.resolve(videoPath);
        proxyLeases.add(release);
        return promise;
    }
    function cancelPlayback(videoPath) {
        const source = path.resolve(videoPath), pending = [];
        proxyLeases.forEach(release => { if (release.source === source) pending.push(release()); });
        return Promise.all(pending);
    }
    window.ArknightPreviewBridge = { create, ensureProxy, preparePlayback: ensureProxy, cancelPlayback };
    if (window.addEventListener) window.addEventListener('unload', () => {
        channels.forEach(api => api.close());
        proxyLeases.forEach(release => { release().catch(() => {}); });
    });
})();
