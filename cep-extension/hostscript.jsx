/*
 * hostscript.jsx —— Premiere Pro ExtendScript 宿主层
 *
 * 运行在 Premiere 的 ExtendScript 引擎里，**只支持 ES3 语法**：
 *   不能用 let/const、箭头函数、模板字符串、Array.prototype.forEach。
 *
 * 与 CEP 面板的通信约定：
 *   面板 → JSX：因 evalScript 有长度与转义限制，大负载一律写成 UTF-8 JSON
 *               临时文件，JSX 用 File 读回（见 _readJson）。
 *   JSX → 面板：返回 JSON 字符串，面板侧 JSON.parse。
 *
 * 单位约定（极易出错，务必留意）：
 *   Track.overwriteClip / insertClip / createSubClip / setInPoint  → ticks（字符串）
 *   MarkerCollection.createMarker                                 → 秒（浮点）
 *   TICKS_PER_SECOND = 254016000000
 */

var Arknight = {};

Arknight.TICKS_PER_SECOND = 254016000000;

// ------------------------------------------------------------------
//  JSON 兼容层
// ------------------------------------------------------------------
// ExtendScript 是 ES3，**没有内置 JSON 对象**。缺了它，本文件所有
// 返回值（JSON.stringify）与载荷读取（JSON.parse）都会抛
// ReferenceError，面板侧表现为「EvalScript error.」——
// 2026-11-07 在 PR 25.3 真机首次运行时踩到。
// 只在宿主确实没有 JSON 时安装 polyfill，实现覆盖本文件用到的
// 全部数据形态（嵌套对象 / 数组 / 字符串 / 数字 / 布尔 / null）。

if (typeof JSON === 'undefined') {
    JSON = {
        stringify: function (v) { return _arkJsonStr(v, []); },
        parse: function (text) { return _arkJsonParse(String(text)); }
    };
}

// ES3 的块级函数声明行为不可靠，这里全部声明在顶层；
// 若宿主自带 JSON（新版本可能带），下面的实现闲置，不会覆盖它。

function _arkJsonQuote(s) {
    var out = '"', i, c, code, hex;
    for (i = 0; i < s.length; i++) {
        c = s.charAt(i);
        code = s.charCodeAt(i);
        if (c === '"') { out += '\\"'; }
        else if (c === '\\') { out += '\\\\'; }
        else if (code === 8) { out += '\\b'; }
        else if (code === 9) { out += '\\t'; }
        else if (code === 10) { out += '\\n'; }
        else if (code === 12) { out += '\\f'; }
        else if (code === 13) { out += '\\r'; }
        else if (code < 32) {
            hex = code.toString(16);
            while (hex.length < 4) { hex = '0' + hex; }
            out += '\\u' + hex;
        } else { out += c; }
    }
    return out + '"';
}

function _arkJsonStr(v, seen) {
    var t = typeof v, i, len, parts = [], k;
    if (v === null || t === 'undefined') { return 'null'; }
    if (t === 'boolean') { return v ? 'true' : 'false'; }
    if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
    if (t === 'string') { return _arkJsonQuote(v); }
    if (t !== 'object') { return 'null'; }   // function 等防御
    for (k = 0; k < seen.length; k++) {
        if (seen[k] === v) { return 'null'; }  // 环引用防御
    }
    seen.push(v);
    parts = [];
    if (v instanceof Array) {
        for (i = 0, len = v.length; i < len; i++) {
            parts.push(_arkJsonStr(v[i], seen));
        }
        seen.pop();
        return '[' + parts.join(',') + ']';
    }
        for (k in v) {
            // 与原生 JSON.stringify 语义一致：对象成员中的 undefined
            // 直接省略（数组元素才转 null）
            if (typeof v[k] === 'function' || typeof v[k] === 'undefined') { continue; }
            parts.push(_arkJsonQuote(String(k)) + ':' + _arkJsonStr(v[k], seen));
        }
    seen.pop();
    return '{' + parts.join(',') + '}';
}

function _arkJsonParse(text) {
    var pos = 0;
    function ws() {
        while (pos < text.length && ' \t\r\n'.indexOf(text.charAt(pos)) >= 0) { pos++; }
    }
    function value() {
        ws();
        var c = text.charAt(pos);
        if (c === '{') { return obj(); }
        if (c === '[') { return arr(); }
        if (c === '"') { return str(); }
        if (text.substr(pos, 4) === 'true') { pos += 4; return true; }
        if (text.substr(pos, 5) === 'false') { pos += 5; return false; }
        if (text.substr(pos, 4) === 'null') { pos += 4; return null; }
        return num();
    }
    function obj() {
        pos++; ws();
        var o = {}, k, ch;
        if (text.charAt(pos) === '}') { pos++; return o; }
        for (;;) {
            ws();
            k = str();
            ws();
            if (text.charAt(pos) !== ':') { throw new Error('JSON 语法错误（应为 :）@' + pos); }
            pos++;
            o[k] = value();
            ws();
            ch = text.charAt(pos);
            if (ch === ',') { pos++; continue; }
            if (ch === '}') { pos++; return o; }
            throw new Error('JSON 语法错误（对象）@' + pos);
        }
    }
    function arr() {
        pos++; ws();
        var a = [], ch;
        if (text.charAt(pos) === ']') { pos++; return a; }
        for (;;) {
            a.push(value());
            ws();
            ch = text.charAt(pos);
            if (ch === ',') { pos++; continue; }
            if (ch === ']') { pos++; return a; }
            throw new Error('JSON 语法错误（数组）@' + pos);
        }
    }
    function str() {
        pos++;
        var out = '', c, e, hex;
        while (pos < text.length) {
            c = text.charAt(pos);
            if (c === '"') { pos++; return out; }
            if (c === '\\') {
                pos++;
                e = text.charAt(pos);
                if (e === 'n') { out += '\n'; pos++; }
                else if (e === 't') { out += '\t'; pos++; }
                else if (e === 'r') { out += '\r'; pos++; }
                else if (e === 'b') { out += '\b'; pos++; }
                else if (e === 'f') { out += '\f'; pos++; }
                else if (e === 'u') {
                    hex = text.substr(pos + 1, 4);
                    out += String.fromCharCode(parseInt(hex, 16));
                    pos += 5;
                } else { out += e; pos++; }
            } else { out += c; pos++; }
        }
        throw new Error('JSON 字符串未闭合');
    }
    function num() {
        var start = pos;
        while (pos < text.length && '0123456789+-.eE'.indexOf(text.charAt(pos)) >= 0) { pos++; }
        if (start === pos) { throw new Error('JSON 语法错误 @' + pos); }
        return parseFloat(text.substr(start, pos - start));
    }
    var v = value();
    ws();
    if (pos !== text.length) { throw new Error('JSON 末尾有多余内容 @' + pos); }
    return v;
}

// ------------------------------------------------------------------
//  日志与工具
// ------------------------------------------------------------------

Arknight.log = function (msg) {
    try {
        app.setSDKEventMessage('[Arknight] ' + msg, 'info');
    } catch (e) { /* Events 面板不可用时静默 */ }
};

Arknight._readJson = function (path) {
    var f = new File(path);
    if (!f.exists) {
        throw new Error('载荷文件不存在: ' + path);
    }
    f.encoding = 'UTF-8';
    if (!f.open('r')) {
        throw new Error('无法打开载荷文件: ' + path);
    }
    var text = f.read();
    f.close();
    // Node 写出的 UTF-8 可能带 BOM，JSON.parse 会失败，先剥掉
    if (text.charCodeAt(0) === 0xFEFF) {
        text = text.substring(1);
    }
    return JSON.parse(text);
};

Arknight._fail = function (stage, e) {
    var detail = (e && e.message) ? e.message : String(e);
    Arknight.log('失败于 ' + stage + ': ' + detail);
    return JSON.stringify({ ok: false, stage: stage, error: detail });
};

// ticks 一律以字符串传递，避免浮点精度损失导致 1~2 帧偏移
Arknight._ticks = function (n) {
    return String(Math.round(Number(n)));
};

Arknight._framesToTicks = function (frames, ticksPerFrame) {
    return Arknight._ticks(Number(frames) * Number(ticksPerFrame));
};

// ------------------------------------------------------------------
//  项目 / 素材查询
// ------------------------------------------------------------------

/** 递归查找引用了指定媒体路径的 ProjectItem（跳过子剪辑）。 */
Arknight._findByPath = function (bin, mediaPath, depth) {
    if (!bin || depth > 12) { return null; }
    var n = 0;
    try { n = bin.children.numItems; } catch (e) { return null; }
    for (var i = 0; i < n; i++) {
        var item = bin.children[i];
        if (!item) { continue; }
        var t = '';
        try { t = String(item.type); } catch (e2) { t = ''; }

        if (t === 'BIN' || t === 'ROOT' || t === '2' || t === '3') {
            var hit = Arknight._findByPath(item, mediaPath, depth + 1);
            if (hit) { return hit; }
            continue;
        }
        var p = '';
        try { p = String(item.getMediaPath()); } catch (e3) { p = ''; }
        if (p && Arknight._samePath(p, mediaPath)) { return item; }
    }
    return null;
};

/** Windows 路径大小写不敏感、分隔符混用，做一次归一化比较。 */
Arknight._samePath = function (a, b) {
    var na = String(a).replace(/\\/g, '/').toLowerCase();
    var nb = String(b).replace(/\\/g, '/').toLowerCase();
    if (na === nb) { return true; }
    // file:/// 前缀与 URL 编码差异
    na = na.replace(/^file:\/+/, '');
    nb = nb.replace(/^file:\/+/, '');
    try { na = decodeURIComponent(na); } catch (e) { }
    try { nb = decodeURIComponent(nb); } catch (e2) { }
    return na === nb;
};

/** 仅保存已有路径的工程；不调用 saveAs，不为未命名工程选择路径。 */
Arknight.saveProject = function () {
    var path = '';
    try {
        var proj = app.project;
        if (!proj) { throw new Error('没有打开的项目'); }
        path = String(proj.path || '');
        if (!path || !/\.prproj$/i.test(path)) {
            throw new Error('工程尚无有效保存路径，请先在 Premiere 中手动另存为');
        }
        if (typeof proj.save !== 'function') { throw new Error('当前宿主不支持 project.save'); }
        var result = proj.save();
        // 文档返回码 0；Premiere 25.3 真机亦返回 true。未知值仍不能宣称成功。
        if (result !== 0 && result !== true) { throw new Error('project.save 未确认保存成功，返回值: ' + String(result)); }
        return JSON.stringify({ ok: true, saved: true, path: path, returnCode: result, saveResult: result });
    } catch (e) {
        return JSON.stringify({ ok: false, saved: false, stage: 'saveProject', path: path,
            saveResult: result === undefined ? null : result, error: e && e.message ? e.message : String(e) });
    }
};

Arknight.findProjectItem = function (mediaPath) {
    var proj = app.project;
    if (!proj) { return null; }

    // 先用官方 API，比手写递归可靠
    try {
        var found = proj.rootItem.findItemsMatchingMediaPath(mediaPath, 1);
        if (found && found.length > 0) { return found[0]; }
    } catch (e) { }

    return Arknight._findByPath(proj.rootItem, mediaPath, 0);
};

/**
 * 收集当前上下文信息，供面板判断「该分析哪个文件」。
 * 优先级：项目面板选中 > 时间轴播放头处的 clip > 活动序列。
 */
Arknight.getHostInfo = function () {
    try {
        var proj = app.project;
        if (!proj) {
            return JSON.stringify({ ok: false, error: '没有打开的项目' });
        }

        var out = {
            ok: true,
            appVersion: String(app.version || ''),
            projectName: String(proj.name || ''),
            projectPath: String(proj.path || ''),
            candidates: [],
            activeSequence: null
        };

        // 1) 项目面板选中项（15.4+）
        try {
            var sel = app.getCurrentProjectViewSelection();
            if (sel && sel.length) {
                for (var i = 0; i < sel.length; i++) {
                    var c = Arknight._describeItem(sel[i]);
                    if (c) { out.candidates.push(c); }
                }
            }
        } catch (e1) { /* 老版本无此 API */ }

        // 2) 时间轴选中项
        var seq = null;
        try { seq = proj.activeSequence; } catch (e2) { seq = null; }
        if (seq) {
            try {
                var tsel = seq.getSelection();
                if (tsel && tsel.length) {
                    for (var j = 0; j < tsel.length; j++) {
                        var pi = null;
                        try { pi = tsel[j].projectItem; } catch (e3) { pi = null; }
                        var d = Arknight._describeItem(pi);
                        if (d) { out.candidates.push(d); }
                    }
                }
            } catch (e4) { }

            out.activeSequence = {
                name: String(seq.name || ''),
                sequenceID: String(seq.sequenceID || ''),
                timebase: String(seq.timebase || ''),
                fps: Arknight._seqFps(seq),
                frameSizeHorizontal: Number(seq.frameSizeHorizontal || 0),
                frameSizeVertical: Number(seq.frameSizeVertical || 0),
                videoTrackCount: Arknight._trackCount(seq.videoTracks),
                audioTrackCount: Arknight._trackCount(seq.audioTracks)
            };
        }

        // 3) 兜底：项目里第一个非序列媒体
        if (out.candidates.length === 0) {
            var fb = Arknight._firstMediaItem(proj.rootItem, 0);
            if (fb) { out.candidates.push(fb); }
        }

        return JSON.stringify(out);
    } catch (e) {
        return Arknight._fail('getHostInfo', e);
    }
};

Arknight._trackCount = function (tracks) {
    try { return Number(tracks.numTracks || 0); } catch (e) { return 0; }
};

Arknight._seqFps = function (seq) {
    // 优先用 timebase（ticks/帧）反推，最准确
    try {
        var tb = parseFloat(seq.timebase);
        if (tb > 0) { return Arknight.TICKS_PER_SECOND / tb; }
    } catch (e) { }
    try {
        var s = seq.getSettings();
        if (s && s.videoFrameRate && s.videoFrameRate.seconds > 0) {
            return 1.0 / Number(s.videoFrameRate.seconds);
        }
    } catch (e2) { }
    return 0;
};

Arknight._describeItem = function (item) {
    if (!item) { return null; }
    var isSeq = false, mediaPath = '', name = '';
    try { isSeq = !!item.isSequence(); } catch (e) { isSeq = false; }
    try { name = String(item.name || ''); } catch (e2) { name = ''; }
    if (isSeq) { return null; }   // 序列不能当源素材分析
    try { mediaPath = String(item.getMediaPath() || ''); } catch (e3) { mediaPath = ''; }
    if (!mediaPath) { return null; }
    return { name: name, mediaPath: mediaPath, nodeId: String(item.nodeId || '') };
};

Arknight._firstMediaItem = function (bin, depth) {
    if (!bin || depth > 8) { return null; }
    var n = 0;
    try { n = bin.children.numItems; } catch (e) { return null; }
    for (var i = 0; i < n; i++) {
        var item = bin.children[i];
        if (!item) { continue; }
        var t = '';
        try { t = String(item.type); } catch (e2) { t = ''; }
        if (t === 'BIN' || t === 'ROOT' || t === '2' || t === '3') {
            var hit = Arknight._firstMediaItem(item, depth + 1);
            if (hit) { return hit; }
            continue;
        }
        var d = Arknight._describeItem(item);
        if (d) { return d; }
    }
    return null;
};

// ------------------------------------------------------------------
//  核心：把保留区间落地成新序列
// ------------------------------------------------------------------

/**
 * payload 结构（由面板写入临时 JSON 文件）：
 * {
 *   mediaPath:   "D:/.../game.mp4",
 *   fps:         60.0,
 *   ranges:      [[0,100],[136,163], ...],     // 源帧区间，右开
 *   markers:     [{record_start, record_end, name, comment, percent, label}],
 *   sequenceName:"明日方舟自动剪辑",
 *   binName:     "ArknightAutoEditing",
 *   sourceOffsetTicks: "0",                     // 源素材起始 tick 偏移（一般为 0）
 *   addMarkers:  true,
 *   openSequence:true
 * }
 */
Arknight.applyEdit = function (payloadPath) {
    var payload = null;
    try {
        payload = Arknight._readJson(payloadPath);
    } catch (e) {
        return Arknight._fail('读取载荷', e);
    }

    var ranges = payload.ranges || [];
    if (ranges.length === 0) {
        return JSON.stringify({ ok: false, stage: 'validate', error: '没有可落地的保留区间' });
    }

    try {
        var proj = app.project;
        if (!proj) { throw new Error('没有打开的项目'); }

        var srcItem = Arknight.findProjectItem(payload.mediaPath);
        if (!srcItem) {
            // 素材不在项目里，先导入
            Arknight.log('项目中未找到素材，尝试导入: ' + payload.mediaPath);
            var bin = null;
            try { bin = proj.getInsertionBin(); } catch (e0) { bin = null; }
            var okImport = proj.importFiles([payload.mediaPath], true, bin, false);
            if (!okImport) { throw new Error('导入素材失败: ' + payload.mediaPath); }
            srcItem = Arknight.findProjectItem(payload.mediaPath);
            if (!srcItem) { throw new Error('导入后仍无法定位素材: ' + payload.mediaPath); }
        }

        var fps = Number(payload.fps);
        var ticksPerFrame = Arknight.TICKS_PER_SECOND / fps;
        var offset = Number(payload.sourceOffsetTicks || 0);
        if (!isFinite(fps) || fps <= 0 || !isFinite(offset)) {
            throw new Error('无效 fps 或 sourceOffsetTicks');
        }

        // ---- 1) 准备存放子剪辑的 bin ----
        var targetBin = Arknight._ensureBin(proj, payload.binName || 'ArknightAutoEditing');

        // ---- 2) 为每个保留区间创建子剪辑 ----
        var subclips = [];
        var failed = [];
        var baseName = String(srcItem.name || 'clip');
        var stamp = Arknight._stamp();

        for (var i = 0; i < ranges.length; i++) {
            var s = Number(ranges[i][0]);
            var e = Number(ranges[i][1]);          // 右开
            var len = e - s;
            if (!isFinite(s) || !isFinite(e) || s < 0 || Math.floor(s) !== s || Math.floor(e) !== e || len <= 0) {
                failed.push({ index: i, start: s, end: e });
                continue;
            }

            var stTicks = Arknight._ticks(s * ticksPerFrame + offset);
            // createSubClip 的 endTime 是「排他」还是「包含」在不同版本上有差异，
            // 这里按排他处理（与我们的右开区间一致），落地后面板会回报实际时长供校验。
            var enTicks = Arknight._ticks(e * ticksPerFrame + offset);
            // 名字必须全局唯一：createSubClip 遇重名可能失败或产生歧义项。
            // 时间戳只到秒，同一秒内跑两次会撞，故再拼一段随机后缀。
            var nm = baseName + '_' + stamp + '_' + Arknight._rand() +
                     '_' + Arknight._pad(i + 1, 4);

            var sc = null;
            try {
                // (name, startTime, endTime, hasHardBoundaries, takeVideo, takeAudio)
                sc = srcItem.createSubClip(nm, stTicks, enTicks, 0, 1, 1);
            } catch (eSc) {
                sc = null;
            }
            if (!sc) {
                failed.push({ index: i, start: s, end: e });
                continue;
            }
            if (targetBin) {
                try { sc.moveBin(targetBin); } catch (eMv) { /* 移动失败不影响主流程 */ }
            }
            subclips.push(sc);
        }

        if (subclips.length === 0) {
            throw new Error('所有子剪辑创建均失败（' + failed.length + ' 个）。' +
                            '请检查当前 Premiere 的 createSubClip 支持情况与宿主日志。');
        }

        // record_start/end 基于全部 ranges；缺任一段都不能沿用这些标记。
        // 在两条建序列路径之前停止。保留已建子剪辑，不删除 bin 或源媒体。
        if (failed.length > 0 || subclips.length !== ranges.length) {
            var incompleteError = '保留区间不完整：' + failed.length +
                ' 个区间未创建子剪辑，已停止拼装，未创建序列或标记。' +
                '已创建的 ' + subclips.length + ' 个子剪辑保留在项目中。';
            Arknight.log(incompleteError);
            return JSON.stringify({
                ok: false,
                stage: 'applyEdit',
                error: incompleteError,
                subclipsCreated: subclips.length,
                clipsFailed: failed.length,
                failedDetail: failed.slice(0, 20),
                markersAdded: 0
            });
        }

        // ---- 3) 用子剪辑顺序拼装新序列 ----
        var seqName = payload.sequenceName || (baseName + ' 自动剪辑');
        var seq = null;
        try {
            seq = proj.createNewSequenceFromClips(seqName, subclips, targetBin);
        } catch (eSeq) {
            seq = null;
        }
        if (!seq) {
            // 兜底：手动建序列 + overwriteClip 逐段写入
            seq = Arknight._assembleByOverwrite(proj, seqName, subclips, ticksPerFrame);
        }
        if (!seq) {
            throw new Error('无法创建目标序列（createNewSequenceFromClips 与 ' +
                            'createNewSequence 均失败）。' +
                            '请检查序列预设与宿主日志。');
        }

        // 时间轴结构必须通过；源坐标语义未真机确认，单独报告为未验证。
        var verification = Arknight._verifyEdit(seq, ranges, fps, offset, subclips, srcItem, payload.mediaPath);
        // ---- 4) 写变速标记 ----
        var markersAdded = 0;
        if (verification.ok && payload.addMarkers !== false && payload.markers && payload.markers.length) {
            markersAdded = Arknight._addMarkers(seq, payload.markers, fps);
        }

        // ---- 5) 打开新序列 ----
        if (payload.openSequence !== false) {
            try { proj.openSequence(seq.sequenceID); } catch (eOpen) { }
        }

        // ---- 6) 回报实际情况，供面板校验帧对齐 ----
        var actualTicks = '0';
        try { actualTicks = String(seq.end || '0'); } catch (eEnd) { }
        // 读回序列里真实的 clip 数：createSubClip 成功不等于拼装成功，
        // 只报「尝试数」会掩盖 createNewSequenceFromClips 半途失败的情况。
        var inSeq = Arknight._countClips(seq);

        Arknight.log((verification.ok ? '落地结构回读通过（源帧精度未验证）：子剪辑 ' : '落地回读失败（序列已保留）：子剪辑 ') + subclips.length + ' 个，序列内 ' +
                     inSeq + ' 段，标记 ' + markersAdded + ' 个');

        return JSON.stringify({
            ok: verification.ok,
            stage: verification.ok ? 'complete' : 'verification',
            error: verification.ok ? '' : '序列回读未通过：请检查 verification，已保留序列，未写入标记',
            verification: verification,
            warnings: verification.warnings,
            sequenceName: String(seq.name || seqName),
            sequenceID: String(seq.sequenceID || ''),
            subclipsCreated: subclips.length,
            clipsInSequence: inSeq,
            clipsFailed: failed.length,
            failedDetail: failed.slice(0, 20),
            markersAdded: markersAdded,
            sequenceEndTicks: actualTicks,
            sequenceFps: Arknight._seqFps(seq),
            timebase: String(seq.timebase || '')
        });
    } catch (e) {
        return Arknight._fail('applyEdit', e);
    }
};

/** 回读 Time.ticks；缺字段不能按 0 处理。 */
Arknight._readTicks = function (time) {
    if (!time || time.ticks === undefined || time.ticks === null || time.ticks === '') { return null; }
    var n = Number(time.ticks);
    return isFinite(n) ? n : null;
};

/** 读取已配置的音频剪辑数；0 表示不预期输出音频，不宣称文件物理上无音轨。 */
Arknight._audioExpectation = function (item) {
    try {
        var mapping = item.getAudioChannelMapping();
        var n = mapping ? mapping.audioClipsNumber : null;
        if (n !== null && n !== undefined && n !== '' && isFinite(Number(n)) && Number(n) >= 0) {
            return Number(n) > 0;
        }
    } catch (e) { }
    return null;
};

/**
 * timeline-structure-v1：必需验证媒体路径、顺序、fps、时长与连续性。
 * TrackItem 文档仅称 in/out 相对 source，未说明 subclip 的 source 原点。
 * source-coordinates-unverified：只记录两种具名候选，不据数值匹配自动选模式。
 * 真机确认之前绝不声称源入出点或完整帧精度已验证。
 */
Arknight._verifyEdit = function (seq, ranges, fps, offset, subclips, srcItem, mediaPath) {
    var expectedAudio = Arknight._audioExpectation(srcItem);
    var audioEvidence = expectedAudio === null ? 'unknown' : 'source-channel-mapping';
    if (expectedAudio === null) {
        var allSilent = true;
        for (var sc = 0; sc < subclips.length; sc++) {
            var hasAudio = Arknight._audioExpectation(subclips[sc]);
            if (hasAudio === true) { expectedAudio = true; break; }
            if (hasAudio !== false) { allSilent = false; }
        }
        if (expectedAudio === null && allSilent) { expectedAudio = false; }
        if (expectedAudio !== null) { audioEvidence = 'subclip-channel-mapping'; }
    }
    var v = { ok: false, status: 'failed', mode: 'timeline-structure-v1',
        sourcePointMode: 'source-coordinates-unverified', sourcePointsVerified: false,
        frameAccurate: false, expectedAudio: expectedAudio, audioEvidence: audioEvidence,
        expectedFps: fps, actualFps: Arknight._seqFps(seq),
        videoClipCount: 0, audioClipCount: 0, tracks: [], failures: [],
        warnings: ['源入出点坐标原点尚未真机确认；完整源帧精度未验证'] };
    if (expectedAudio === null) { v.warnings.push('音频输出预期未知，未确认音频完整性'); }
    var tpf = Arknight.TICKS_PER_SECOND / fps;
    // 仅容忍 tick 取整误差，绝不容忍一帧误差。
    var tolerance = 2;
    if (!v.actualFps || Math.abs(v.actualFps - fps) > fps * 0.000001) {
        v.failures.push('序列 fps 与请求不一致或不可读');
    }
    var kinds = ['video', 'audio'];
    var total = 0;
    var i, j, k;
    for (i = 0; i < ranges.length; i++) { total += (ranges[i][1] - ranges[i][0]) * tpf; }
    v.expectedEndTicks = Arknight._ticks(total);
    try {
        var end = seq.end;
        v.actualEndTicks = end && end.ticks !== undefined ? String(end.ticks) : String(end);
        if (!isFinite(Number(v.actualEndTicks)) || Math.abs(Number(v.actualEndTicks) - total) > tolerance) {
            v.failures.push('序列总时长不一致或不可读');
        }
    } catch (endError) { v.failures.push('序列总时长不可读'); }
    for (k = 0; k < kinds.length; k++) {
        var kind = kinds[k];
        var count = 0;
        try {
            var tracks = k === 0 ? seq.videoTracks : seq.audioTracks;
            var trackCount = Number(tracks.numTracks);
            if (!isFinite(trackCount) || trackCount < 0) { throw new Error('轨道数量不可读'); }
            for (i = 0; i < trackCount; i++) {
                var clips = tracks[i].clips;
                var n = clips.numItems;
                if (n === undefined || n === null) { n = clips.length; }
                n = Number(n);
                if (!isFinite(n) || n < 0) { throw new Error('片段数量不可读'); }
                count += n;
                var report = { kind: kind, trackIndex: i, clipCount: n, clips: [] };
                v.tracks.push(report);
                if (n === 0) { continue; }
                if (n !== ranges.length) { v.failures.push(kind + ' 轨道 ' + i + ' 片段数量不一致'); }
                var cursor = 0;
                for (j = 0; j < n; j++) {
                    var clip = clips[j];
                    var actual = { index: j, inTicks: Arknight._readTicks(clip.inPoint),
                        outTicks: Arknight._readTicks(clip.outPoint), durationTicks: Arknight._readTicks(clip.duration),
                        startTicks: Arknight._readTicks(clip.start), endTicks: Arknight._readTicks(clip.end) };
                    report.clips.push(actual);
                    if (j >= ranges.length) { continue; }
                    var duration = (ranges[j][1] - ranges[j][0]) * tpf;
                    actual.expected = { inTicks: Math.round(ranges[j][0] * tpf + offset),
                        outTicks: Math.round(ranges[j][1] * tpf + offset), durationTicks: Math.round(duration),
                        startTicks: Math.round(cursor), endTicks: Math.round(cursor + duration) };
                    actual.sourcePointCandidates = {
                        'original-media': { inTicks: actual.expected.inTicks, outTicks: actual.expected.outTicks },
                        'subclip-relative': { inTicks: 0, outTicks: Math.round(duration) }
                    };
                    actual.sourcePointStatus = 'unverified';
                    if (actual.inTicks === null || actual.outTicks === null ||
                        Math.abs(actual.inTicks - actual.expected.inTicks) > tolerance ||
                        Math.abs(actual.outTicks - actual.expected.outTicks) > tolerance) {
                        v.warnings.push(kind + ' 第 ' + j + ' 段源点不可读或不匹配 original-media 候选；未验证');
                    }
                    var actualPath = '';
                    try { actualPath = String(clip.projectItem.getMediaPath() || ''); } catch (pathError) { }
                    actual.mediaPath = actualPath;
                    if (!actualPath || !Arknight._samePath(actualPath, mediaPath)) {
                        v.failures.push(kind + ' 第 ' + j + ' 段媒体路径不匹配或不可读');
                    }
                    var fields = ['durationTicks', 'startTicks', 'endTicks'];
                    for (var f = 0; f < fields.length; f++) {
                        var field = fields[f];
                        if (actual[field] === null || Math.abs(actual[field] - actual.expected[field]) > tolerance) {
                            v.failures.push(kind + ' 轨道 ' + i + ' 第 ' + j + ' 段 ' + field + ' 不一致或不可读');
                        }
                    }
                    // nodeId 可用时再核对身份；时间点核对始终执行。
                    var expectedId = subclips[j].nodeId;
                    var actualId = clip.projectItem ? clip.projectItem.nodeId : null;
                    if (expectedId !== undefined && expectedId !== null &&
                        (actualId === undefined || actualId === null || String(actualId) !== String(expectedId))) {
                        v.failures.push(kind + ' 轨道 ' + i + ' 第 ' + j + ' 段源剪辑顺序不一致');
                    }
                    cursor += duration;
                }
            }
        } catch (readError) {
            if (k === 1 && expectedAudio !== true) { v.warnings.push(kind + ' 回读未确认: ' + String(readError)); }
            else { v.failures.push(kind + ' 回读失败: ' + String(readError)); }
        }
        if (k === 0) { v.videoClipCount = count; } else { v.audioClipCount = count; }
        if (count === 0 && (k === 0 || expectedAudio === true)) {
            v.failures.push(kind + ' 未读到预期片段');
        }
        if (k === 1 && count > 0 && expectedAudio === false) {
            v.warnings.push('音频映射不预期输出但序列包含音频，请检查映射');
        }
    }
    v.ok = v.failures.length === 0;
    v.status = v.ok ? 'partial' : 'failed';
    return v;
};

/** 找或建一个具名 bin，用于收纳子剪辑，避免污染项目面板根目录。 */
Arknight._ensureBin = function (proj, name) {
    try {
        var root = proj.rootItem;
        var n = root.children.numItems;
        for (var i = 0; i < n; i++) {
            var it = root.children[i];
            try {
                if ((String(it.type) === 'BIN' || String(it.type) === '2') && String(it.name) === name) { return it; }
            } catch (e) { }
        }
        return root.createBin(name);
    } catch (e2) {
        return null;
    }
};

/**
 * createNewSequenceFromClips 不可用时的兜底：建序列 + 逐段 overwriteClip。
 *
 * 坑：createNewSequence(name, presetPath) 的第二个参数必须是**真实存在的
 * .sqpreset 路径**。之前这里传的是一个拼出来的时间戳字符串，多数版本上会
 * 直接抛错并返回 null —— 也就是说这条兜底路径从未真正生效过。
 * 现在先试空串（多数版本会退回默认预设），失败再去安装目录里找一个预设。
 */
Arknight._assembleByOverwrite = function (proj, seqName, subclips, ticksPerFrame) {
    var seq = null;
    try { seq = proj.createNewSequence(seqName, ''); } catch (e) { seq = null; }

    if (!seq) {
        var preset = Arknight._findSequencePreset();
        if (!preset) {
            Arknight.log('兜底拼装失败：默认预设建序列失败，且未在安装目录里找到 .sqpreset');
            return null;
        }
        Arknight.log('改用序列预设: ' + preset);
        try { seq = proj.createNewSequence(seqName, preset); } catch (e2) { seq = null; }
    }
    if (!seq) { return null; }

    var vTrack = null;
    try { vTrack = seq.videoTracks[0]; } catch (e3) { vTrack = null; }
    if (!vTrack) { return seq; }

    var cursor = 0;
    for (var i = 0; i < subclips.length; i++) {
        try {
            vTrack.overwriteClip(subclips[i], Arknight._ticks(cursor));
        } catch (e4) {
            Arknight.log('overwriteClip 第 ' + i + ' 段失败: ' + e4.message);
        }
        // 子剪辑时长 = 其 in/out 之差
        var dur = 0;
        try {
            dur = parseFloat(subclips[i].getOutPoint(1).ticks) -
                  parseFloat(subclips[i].getInPoint(1).ticks);
        } catch (e5) { dur = 0; }
        if (dur > 0) { cursor += dur; } else { cursor += ticksPerFrame; }
    }
    return seq;
};

/**
 * 在安装目录里找第一个可用的序列预设。
 * 只搜 Presets/Sequence Presets 这棵小树（深度 3）就返回，避免
 * 对整个 Presets 目录做全量遍历 —— ExtendScript 的 Folder.getFiles()
 * 在几千个文件的目录上会明显卡顿。
 */
Arknight._findSequencePreset = function () {
    var root = null;
    try {
        root = new Folder(new Folder(String(app.getAppPath())).fsName +
                          '/Presets/Sequence Presets');
    } catch (e) { return ''; }
    if (!root || !root.exists) { return ''; }
    return Arknight._searchPreset(root, 0);
};

Arknight._searchPreset = function (folder, depth) {
    if (!folder || depth > 3) { return ''; }
    var items = null;
    try { items = folder.getFiles(); } catch (e) { return ''; }
    if (!items) { return ''; }
    var subFolders = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        try {
            if (it instanceof Folder) {
                subFolders.push(it);
            } else if (/\.sqpreset$/i.test(String(it.name))) {
                return String(it.fsName);
            }
        } catch (e2) { }
    }
    // 优先在子目录里找，避免同级文件顺序造成的意外选择
    for (var j = 0; j < subFolders.length; j++) {
        var hit = Arknight._searchPreset(subFolders[j], depth + 1);
        if (hit) { return hit; }
    }
    return '';
};

/**
 * 写序列标记。注意 createMarker 收的是**秒**，不是 ticks。
 * 标记的 record_start/record_end 由 Python 侧按 keep_ranges 换算好。
 */
Arknight._addMarkers = function (seq, markers, fps) {
    var mc = null;
    try { mc = seq.markers; } catch (e) { return 0; }
    if (!mc) { return 0; }

    var added = 0;
    for (var i = 0; i < markers.length; i++) {
        var m = markers[i];
        var startSec = Number(m.record_start || 0) / fps;
        var endSec = Number(m.record_end || m.record_start || 0) / fps;
        // 至少 1 帧长，否则标记在时间轴上不可见
        if (endSec <= startSec) { endSec = startSec + (1.0 / fps); }

        var mk = null;
        try { mk = mc.createMarker(startSec); } catch (e2) { mk = null; }
        if (!mk) { continue; }

        try { mk.name = String(m.name || '变速'); } catch (e3) { }
        try { mk.comments = String(m.comment || ''); } catch (e4) { }
        try { mk.type = 'Comment'; } catch (e5) { }
        try {
            var t = mk.end;
            if (t) { t.seconds = endSec; mk.end = t; }
        } catch (e6) { }
        // 橙色标记，视觉上和普通注释区分开（13.x+，失败可忽略）
        try { mk.setColorByIndex(7); } catch (e7) { }
        added++;
    }
    return added;
};

Arknight._stamp = function () {
    var d = new Date();
    return String(d.getFullYear()) + Arknight._pad(d.getMonth() + 1, 2) +
           Arknight._pad(d.getDate(), 2) + '_' + Arknight._pad(d.getHours(), 2) +
           Arknight._pad(d.getMinutes(), 2) + Arknight._pad(d.getSeconds(), 2);
};

Arknight._pad = function (v, w) {
    var s = String(v);
    while (s.length < w) { s = '0' + s; }
    return s;
};

/** ExtendScript 是 ES3，没有 crypto.randomUUID，用 Math.random 拼一个短标识。 */
Arknight._rand = function () {
    var s = '';
    for (var i = 0; i < 4; i++) {
        s += Math.floor(Math.random() * 36).toString(36);
    }
    return s;
};

/** 读回序列里实际的 clip 数量，用于给出诚实的成功报告。 */
Arknight._countClips = function (seq) {
    try {
        var tr = seq.videoTracks[0];
        if (!tr || !tr.clips) { return -1; }
        // TrackItemCollection 在不同版本上暴露 numItems 或 length
        var n = tr.clips.numItems;
        if (n === undefined || n === null) { n = tr.clips.length; }
        return (n === undefined || n === null) ? -1 : Number(n);
    } catch (e) {
        return -1;
    }
};

// ------------------------------------------------------------------
//  互换导出
// ------------------------------------------------------------------

/** 导出整个项目为 FCP XML（ExtendScript 原生能力，UXP 没有）。 */
Arknight.exportFcpxml = function (outPath) {
    try {
        var proj = app.project;
        if (!proj) { throw new Error('没有打开的项目'); }
        var r = proj.exportFinalCutProXML(outPath, 1);
        return JSON.stringify({ ok: (r === 0 || r === true), path: String(outPath) });
    } catch (e) {
        return Arknight._fail('exportFcpxml', e);
    }
};

/** 把活动序列导出为 FCP XML。 */
Arknight.exportSequenceFcpxml = function (outPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) { throw new Error('没有活动序列'); }
        var r = seq.exportAsFinalCutProXML(outPath);
        return JSON.stringify({ ok: !!r, path: String(outPath) });
    } catch (e) {
        return Arknight._fail('exportSequenceFcpxml', e);
    }
};

/**
 * 导入 EDL。Premiere 导入 CMX3600 时会直接生成一条序列，
 * 仅报告导入请求结果，不保证素材重链、帧率或帧边界正确。
 * 特别是 60/59.94 fps 尚未验证，不能作为可靠落地路径。
 */
Arknight.importEdl = function (edlPath) {
    try {
        var proj = app.project;
        if (!proj) { throw new Error('没有打开的项目'); }

        var f = new File(edlPath);
        if (!f.exists) { throw new Error('EDL 文件不存在: ' + edlPath); }

        var before = Arknight._sequenceIds(proj);
        var bin = null;
        try { bin = proj.getInsertionBin(); } catch (e0) { bin = null; }

        // suppressUI=true：EDL 的时码/素材不匹配警告会弹窗打断流程，
        // 但抑制后仍会导入，缺失素材显示为离线，用户可自行重链。
        var okImport = proj.importFiles([edlPath], true, bin, false);
        if (!okImport) { throw new Error('导入 EDL 失败（Premiere 拒绝了该文件）'); }

        var created = Arknight._newSequenceIds(proj, before);
        Arknight.log('EDL 导入完成，新建序列 ' + created.length + ' 条');
        return JSON.stringify({
            ok: true,
            path: String(edlPath),
            newSequenceIds: created,
            reliable: false,
            verification: { ok: false, status: 'unverified' },
            warnings: ['EDL 仅确认导入请求成功，未验证素材、帧率与帧边界；60/59.94 fps 不属于已验证可靠路径']
        });
    } catch (e) {
        return Arknight._fail('importEdl', e);
    }
};

Arknight._sequenceIds = function (proj) {
    var ids = [];
    try {
        var n = proj.sequences.numSequences;
        for (var i = 0; i < n; i++) {
            ids.push(String(proj.sequences[i].sequenceID || ''));
        }
    } catch (e) { }
    return ids;
};

Arknight._newSequenceIds = function (proj, before) {
    var now = Arknight._sequenceIds(proj);
    var out = [];
    for (var i = 0; i < now.length; i++) {
        var found = false;
        for (var j = 0; j < before.length; j++) {
            if (before[j] === now[i]) { found = true; break; }
        }
        if (!found && now[i]) { out.push(now[i]); }
    }
    return out;
};

// ------------------------------------------------------------------
//  诊断：探测当前版本对关键 API 的支持情况
// ------------------------------------------------------------------

Arknight.checkCapabilities = function () {
    var caps = { ok: true, appVersion: String(app.version || ''), checks: {} };
    var proj = app.project;

    caps.checks.hasProject = !!proj;
    caps.checks.getCurrentProjectViewSelection = (typeof app.getCurrentProjectViewSelection === 'function');
    caps.checks.createSubClip = false;
    caps.checks.createNewSequenceFromClips = false;
    caps.checks.importFiles = false;
    caps.checks.markers = false;
    caps.checks.qeDom = false;

    if (proj) {
        caps.checks.createNewSequenceFromClips = (typeof proj.createNewSequenceFromClips === 'function');
        caps.checks.importFiles = (typeof proj.importFiles === 'function');

        var item = Arknight._firstMediaItem(proj.rootItem, 0);
        if (item) {
            caps.checks.probeItemPath = item.mediaPath;
        }
        // createSubClip 只能靠实际对象探测，这里检查任意媒体项
        try {
            var anyItem = Arknight._anyMediaItem(proj.rootItem, 0);
            caps.checks.createSubClip = !!anyItem && (typeof anyItem.createSubClip === 'function');
        } catch (e) { caps.checks.createSubClip = false; }

        try {
            var seq = proj.activeSequence;
            caps.checks.markers = !!(seq && seq.markers && typeof seq.markers.createMarker === 'function');
        } catch (e2) { caps.checks.markers = false; }
    }

    try {
        caps.checks.qeDom = !!(app.enableQE && app.enableQE());
    } catch (e3) { caps.checks.qeDom = false; }

    return JSON.stringify(caps);
};

Arknight._anyMediaItem = function (bin, depth) {
    if (!bin || depth > 8) { return null; }
    var n = 0;
    try { n = bin.children.numItems; } catch (e) { return null; }
    for (var i = 0; i < n; i++) {
        var it = bin.children[i];
        if (!it) { continue; }
        var t = '';
        try { t = String(it.type); } catch (e2) { t = ''; }
        if (t === 'BIN' || t === 'ROOT' || t === '2' || t === '3') {
            var hit = Arknight._anyMediaItem(it, depth + 1);
            if (hit) { return hit; }
            continue;
        }
        var isSeq = false;
        try { isSeq = !!it.isSequence(); } catch (e3) { isSeq = false; }
        if (!isSeq) { return it; }
    }
    return null;
};
