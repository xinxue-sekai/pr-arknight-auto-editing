/**
 * csinterface.js —— CSInterface 最小实现（精简版）
 *
 * 官方 CSInterface.js 约千行，其中绝大部分是本扩展用不到的能力
 * （主题色回调、拖拽、打开其他扩展、请求签名校验等）。这里只实现
 * 实际用到的三项，好处是：
 *   1. 仓库自包含，不需要额外下载 Adobe 的 SDK 文件
 *   2. 行为完全透明，出问题容易排查
 *
 * 如果你需要完整的官方能力，直接用 CEP-Resources 里的 CSInterface.js
 * 覆盖本文件即可，调用方式一致。
 *
 * 依赖 manifest 里的 window.__adobe_cep__ 宿主注入对象。
 */
(function () {
    'use strict';

    var host = window.__adobe_cep__;

    function CSInterface() {
        // 宿主未注入时（例如在普通浏览器里调试 UI）退化为桩，
        // 让界面能渲染出来，只是无法与 Premiere 通信。
        this.available = !!host;
    }

    CSInterface.EXTENSION = 'EXTENSION';
    CSInterface.HOST_APPLICATION = 'HOST_APPLICATION';
    CSInterface.USER_DATA = 'USER_DATA';

    /**
     * 在 Premiere 的 ExtendScript 引擎里执行脚本。
     * @param {string} script   要执行的 JSX 代码
     * @param {function} callback 收到返回值的字符串（JSX 侧一律 return JSON 字符串）
     */
    CSInterface.prototype.evalScript = function (script, callback) {
        var cb = (typeof callback === 'function') ? callback : function () {};
        if (!host) {
            cb('__CSINTERFACE_UNAVAILABLE__');
            return;
        }
        host.invokeAsync('evalScript', script, cb);
    };

    /** 取扩展自身安装目录 / 宿主程序目录 / 用户数据目录的绝对路径。 */
    CSInterface.prototype.getSystemPath = function (pathType) {
        if (!host) { return ''; }
        var p = '';
        try {
            p = decodeURI(host.getSystemPath(pathType));
        } catch (e) {
            p = host.getSystemPath(pathType) || '';
        }
        // Windows 下宿主返回的是 file:///C:/... 形式，统一剥掉协议前缀
        p = p.replace(/^file:\/\/\//, '');
        if (navigator.platform.indexOf('Win') === 0) {
            p = p.replace(/\//g, '\\');
        }
        return p;
    };

    CSInterface.prototype.getOSVersion = function () {
        return host ? host.getOSVersion() : '';
    };

    CSInterface.prototype.closeExtension = function () {
        if (host) { host.closeExtension(); }
    };

    /**
     * evalScript 的 Promise 封装，并在返回值上做 JSON 解析。
     * 这是本扩展内部实际使用的主要形式。
     * @returns {Promise<*>} 解析后的对象；JSX 抛错时 reject
     */
    CSInterface.prototype.evalJSON = function (script) {
        var self = this;
        return new Promise(function (resolve, reject) {
            self.evalScript(script, function (raw) {
                if (raw === '__CSINTERFACE_UNAVAILABLE__') {
                    reject(new Error('CSInterface 不可用：请在 Premiere 面板中打开本扩展'));
                    return;
                }
                if (raw === 'EvalScript error.' || raw === undefined || raw === null) {
                    reject(new Error('ExtendScript 执行失败（无返回值）。请检查 Premiere 的 Events 面板日志。'));
                    return;
                }
                var text = String(raw).trim();
                if (!text) {
                    reject(new Error('ExtendScript 返回空值'));
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                } catch (e) {
                    // 非 JSON 说明 JSX 里出现了未捕获的语法/运行时错误
                    reject(new Error('ExtendScript 返回非 JSON: ' + text.slice(0, 500)));
                }
            });
        });
    };

    window.CSInterface = CSInterface;
})();
