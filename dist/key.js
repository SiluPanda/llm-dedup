"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sortedStringify = sortedStringify;
exports.hashString = hashString;
exports.canonicalizeKey = canonicalizeKey;
const crypto_1 = require("crypto");
const RELEVANT_FIELDS = [
    'messages',
    'model',
    'temperature',
    'top_p',
    'max_tokens',
    'frequency_penalty',
    'presence_penalty',
    'seed',
    'tools',
    'tool_choice',
    'response_format',
    'stop',
    'system',
];
function sortedStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(sortedStringify).join(',') + ']';
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(k => JSON.stringify(k) + ':' + sortedStringify(obj[k]));
    return '{' + parts.join(',') + '}';
}
function hashString(text) {
    return (0, crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
function canonicalizeKey(params, normalizer) {
    let extracted = {};
    if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
        const p = params;
        for (const field of RELEVANT_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(p, field)) {
                extracted[field] = p[field];
            }
        }
    }
    else {
        extracted = { _raw: params };
    }
    let text = sortedStringify(extracted);
    if (normalizer) {
        text = normalizer(text);
    }
    return hashString(text);
}
//# sourceMappingURL=key.js.map