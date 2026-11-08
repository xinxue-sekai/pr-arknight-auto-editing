'use strict';

/** Zero-dependency validation of the CEP manifest structure used by this project.
 * Not a general XML/XSD validator. Reject unsupported syntax rather than guessing.
 */
function parseManifest(xml) {
    const error = message => { throw new Error('CEP manifest: ' + message); };
    const text = xml.replace(/^\uFEFF/, '').replace(/<!--([\s\S]*?)-->/g, (_, body) => {
        if (body.includes('--')) { error('invalid XML comment'); }
        return '';
    }).replace(/^\s*<\?xml\s[^?]*\?>/, '');
    const document = { children: [] };
    const stack = [document];
    const token = /<([^<>]+)>/g;
    let end = 0;
    let match;
    while ((match = token.exec(text))) {
        if (text.slice(end, match.index).includes('<') ||
            (stack.length === 1 && text.slice(end, match.index).trim())) {
            error('invalid XML text');
        }
        end = token.lastIndex;
        const close = /^\/([\w.-]+)\s*$/.exec(match[1]);
        if (close) {
            if (stack.length === 1 || stack.pop().name !== close[1]) { error('unbalanced XML tags'); }
            continue;
        }
        const open = /^([\w.-]+)((?:\s+[\s\S]*?)?)\s*(\/?)$/.exec(match[1]);
        if (!open) { error('unsupported XML tag'); }
        const attrs = Object.create(null);
        const rest = open[2].replace(/\s+([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g, (_, key, value) => {
            if (Object.prototype.hasOwnProperty.call(attrs, key)) { error('duplicate attribute ' + key); }
            attrs[key] = value.slice(1, -1);
            return '';
        });
        if (rest.trim()) { error('invalid XML attributes'); }
        const node = { name: open[1], attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!open[3]) { stack.push(node); }
    }
    if (stack.length !== 1 || text.slice(end).trim()) { error('unbalanced or invalid XML'); }
    const root = document.children[0];
    if (document.children.length !== 1 || root.name !== 'ExtensionManifest') {
        error('root must be ExtensionManifest');
    }
    if (root.attrs.Version !== '7.0') { error('ExtensionManifest@Version must be 7.0 (schema version)'); }
    if (root.attrs.xmlns) { error('ExtensionManifest must not use a default namespace'); }
    const bundleId = root.attrs.ExtensionBundleId;
    const version = root.attrs.ExtensionBundleVersion;
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(bundleId || '')) { error('invalid ExtensionBundleId'); }
    if (!/^\d+\.\d+\.\d+$/.test(version || '')) { error('invalid ExtensionBundleVersion'); }
    const names = root.children.map(node => node.name).join(',');
    if (names !== 'ExtensionList,ExecutionEnvironment,DispatchInfoList') {
        error('expected ExtensionList, ExecutionEnvironment, DispatchInfoList in order');
    }
    function extensionIds(parent) {
        if (!parent.children.length) { error(parent.name + ' must contain Extension'); }
        const ids = parent.children.map(node => {
            if (node.name !== 'Extension' || !(node.attrs.Id || '').startsWith(bundleId + '.')) {
                error(parent.name + ' has invalid Extension@Id');
            }
            if (node.attrs.Version && !/^\d+\.\d+\.\d+$/.test(node.attrs.Version)) {
                error('invalid Extension@Version');
            }
            return node.attrs.Id;
        });
        if (new Set(ids).size !== ids.length) { error(parent.name + ' has duplicate Extension@Id'); }
        return ids.sort();
    }
    const extensionIdsList = extensionIds(root.children[0]);
    const dispatchIds = extensionIds(root.children[2]);
    if (extensionIdsList.join(',') !== dispatchIds.join(',')) {
        error('ExtensionList and DispatchInfoList IDs must match');
    }
    return { bundleId, version, schemaVersion: root.attrs.Version, extensionIds: dispatchIds };
}

module.exports = { parseManifest };
