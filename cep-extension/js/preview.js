/* Independent still-frame review and single-element audio/video playback. */
(function () {
    'use strict';
    function fileURL(path) {
        if (/^(file|https?):/i.test(path)) return path;
        const p = path.replace(/\\/g, '/');
        return 'file://' + (p.charAt(0) === '/' ? '' : '/') + p.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
    }
    class Preview {
        constructor(elements, onPosition) {
            this.el = elements;
            this.onPosition = onPosition;
            this.epoch = 0;
            this.channels = {};
            this.frame = 0;
            this.fps = 30;
            this.total = 0;
            this.metadataStatus = 'unknown';
            this.fpsStatus = 'unknown';
            this.ranges = [];
            this.cut = false;
            this.rect = null;
            this.dimensions = null;
            this.playing = false;
            this.imagesReady = {};
            ['main', 'before', 'after'].forEach(k => {
                const image = elements[k];
                image.hidden = true;
                image.addEventListener('load', () => {
                    if (!image.getAttribute('src')) return;
                    this.imagesReady[k] = true;
                    image.hidden = k === 'main' && this.playing;
                });
                image.addEventListener('error', () => {
                    this.clearImage(k);
                    this.message('静帧图片加载失败，请重新定位帧');
                });
            });
            const v = elements.video;
            v.addEventListener('error', () => this.playbackFallback());
            v.addEventListener('timeupdate', () => this.updatePlayback());
            v.addEventListener('ended', () => this.pause());
        }
        async playbackFallback() {
            this.pause();
            const bridge = window.ArknightPreviewBridge;
            if (this.proxyPending) return;
            if (this.proxyAttempted || !bridge || !bridge.preparePlayback) {
                this.message('当前素材无法由 HTML video 播放，且没有可用播放代理；可继续静帧审阅。'); return;
            }
            this.proxyAttempted = true; this.proxyPending = true;
            const epoch = this.epoch;
            this.message('原片编码不受支持，正在生成音视频播放代理…');
            try {
                const lease = bridge.preparePlayback(this.path);
                this.proxyLease = lease;
                const result = await lease;
                if (epoch !== this.epoch) { if (result.cleanup) await result.cleanup(); return; }
                this.el.video.src = fileURL(result.path);
                this.el.video.load();
                this.message('音视频代理已准备，可点击播放；静帧仍使用源片。');
            } catch (e) {
                if (epoch === this.epoch) this.message('播放代理不可用：' + e.message + '；可继续静帧审阅。');
            } finally { if (epoch === this.epoch) this.proxyPending = false; }
        }
        setContentRect(rect) { this.rect = rect; this.drawRect(); }
        drawRect() {
            const overlay = this.el.overlay, r = this.rect, d = this.dimensions;
            if (!overlay) return;
            overlay.hidden = !r || !d;
            if (!r || !d) return;
            const width = d.sourceWidth || d.width, height = d.sourceHeight || d.height;
            overlay.style.left = (r.x / width * 100) + '%';
            overlay.style.top = (r.y / height * 100) + '%';
            overlay.style.width = (r.width / width * 100) + '%';
            overlay.style.height = (r.height / height * 100) + '%';
        }
        clearImage(key) {
            this.imagesReady[key] = false;
            this.el[key].hidden = true;
            this.el[key].removeAttribute('src');
        }
        message(text) { this.el.status.textContent = text; }
        open(path) {
            this.epoch++;
            const bridge = window.ArknightPreviewBridge;
            this.pause();
            this.el.video.removeAttribute('src');
            this.el.video.load();
            if (this.proxyLease && this.proxyLease.cleanup) {
                this.proxyLease.cleanup().catch(() => {});
            }
            this.proxyLease = null;
            this.path = path; this.proxyAttempted = false; this.proxyPending = false;
            this.pause();
            Object.keys(this.channels).forEach(k => this.channels[k].service && this.channels[k].service.close());
            this.channels = {};
            this.total = 0;
            this.fps = 30;
            this.metadataStatus = 'unknown';
            this.fpsStatus = 'unknown';
            this.dimensions = null; this.drawRect();
            this.frame = 0;
            this.ranges = [];
            ['main', 'before', 'after'].forEach(k => this.clearImage(k));
            this.el.video.removeAttribute('src');
            this.el.video.load();
            if (!path) { this.message('请选择素材'); return; }
            this.el.video.src = fileURL(path);
            this.message('正在请求画面…');
            if (!window.ArknightPreviewBridge) {
                this.message('静帧预览服务尚未加载；HTML video 播放取决于素材编码支持。');
                return;
            }
            const epoch = this.epoch;
            ['main', 'before', 'after'].forEach(k => {
                const channel = { service: null, pending: null, wanted: null, failed: false };
                this.channels[k] = channel;
                try {
                    channel.service = window.ArknightPreviewBridge.create(path, {
                        channel: k,
                        onFrame: data => {
                            if (epoch !== this.epoch || channel.failed || channel.pending === null) return;
                            if (data.requestId !== channel.requestId || data.frame !== channel.wanted) return;
                            channel.pending = null;
                            this.imagesReady[k] = false;
                            this.el[k].hidden = true;
                            this.el[k].src = fileURL(data.path);
                            this.el[k].alt = '源帧 ' + data.frame;
                            if (k === 'main') {
                                this.dimensions = data; this.drawRect();
                                if (this.metadataStatus !== 'session' && Number.isSafeInteger(data.totalFrames) && data.totalFrames > 0) {
                                    this.total = data.totalFrames;
                                    this.metadataStatus = 'estimate';
                                    this.fpsStatus = Number.isFinite(data.fps) && data.fps > 0 ? 'estimate' : 'unknown';
                                    if (this.fpsStatus !== 'unknown') this.fps = data.fps;
                                }
                                this.onPosition(this.frame, this.positionInfo());
                            }
                            if (k === 'main') this.message('源帧 ' + data.frame + ' · ' + data.width + '×' + data.height);
                        },
                        onError: error => {
                            if (epoch !== this.epoch) return;
                            channel.failed = true;
                            channel.pending = null;
                            this.message('静帧预览失败：' + error.message);
                        }
                    });
                } catch (error) { channel.failed = true; this.message('静帧预览失败：' + error.message); }
            });
            this.request('main', 0);
        }
        request(key, frame) {
            const c = this.channels[key];
            if (!c || !c.service || c.failed) return;
            c.wanted = Math.max(0, Math.round(frame));
            c.pending = c.wanted;
            try { c.requestId = c.service.seek(c.pending); }
            catch (e) { c.pending = null; c.failed = true; this.message('静帧预览失败：' + e.message); }
        }
        positionInfo() {
            return { totalFrames: this.total, fps: this.fpsStatus === 'unknown' ? null : this.fps,
                metadataStatus: this.metadataStatus, fpsStatus: this.fpsStatus };
        }
        configure(fps, total, ranges) {
            if (total > 0) {
                this.fps = fps; this.total = total;
                this.metadataStatus = 'session'; this.fpsStatus = 'session';
            } else if (this.metadataStatus === 'session') {
                this.total = 0; this.metadataStatus = 'unknown'; this.fpsStatus = 'unknown';
            }
            this.ranges = ranges || [];
            this.seek(this.frame);
        }
        seek(frame) {
            this.pause();
            this.frame = Math.max(0, Math.min(Math.max(0, this.total - 1), Math.round(frame)));
            this.request('main', this.frame);
            this.onPosition(this.frame, this.positionInfo());
        }
        compare(seg) {
            ['before', 'after'].forEach(k => {
                this.clearImage(k);
                if (this.channels[k]) this.channels[k].pending = null;
            });
            if (!seg) return;
            this.request('before', Math.max(0, seg.start - 1));
            this.request('after', Math.min(this.total - 1, seg.end + 1));
        }
        pause() {
            this.playing = false;
            this.el.video.pause();
            this.el.video.hidden = true;
            this.el.main.hidden = !this.imagesReady.main;
        }
        play(cut) {
            if (this.playing) { this.seek(this.frame); return; }
            if (!this.total || this.fpsStatus === 'unknown') { this.message('帧率或总帧数未知，请先分析；可继续静帧审阅'); return; }
            this.cut = cut;
            if (cut && !this.ranges.length) { this.message('没有保留区间可播放'); return; }
            let frame = this.frame;
            if (cut) {
                const range = this.ranges.find(r => r[1] > frame) || this.ranges[0];
                frame = Math.max(range[0], frame < range[1] ? frame : range[0]);
            }
            const v = this.el.video;
            v.currentTime = frame / this.fps;
            v.hidden = false; this.el.main.hidden = true; this.playing = true;
            this.message(cut ? '剪后试听：浏览器跳切，非帧精确导出' : '原片音视频播放');
            const epoch = this.epoch;
            const promise = v.play();
            if (promise && promise.catch) promise.catch(e => {
                if (epoch !== this.epoch) return;
                if (e.name === 'NotSupportedError') this.playbackFallback();
                else { this.pause(); this.message('播放失败：' + e.message); }
            });
        }
        updatePlayback() {
            if (!this.playing) return;
            const frame = Math.min(this.total - 1, Math.floor(this.el.video.currentTime * this.fps));
            if (this.cut) {
                const range = this.ranges.find(r => r[1] > frame);
                if (!range) { this.seek(this.ranges[this.ranges.length - 1][1] - 1); return; }
                if (frame < range[0]) { this.el.video.currentTime = range[0] / this.fps; return; }
            }
            this.frame = frame; this.onPosition(frame);
        }
    }
    window.ArknightPreview = Preview;
})();
