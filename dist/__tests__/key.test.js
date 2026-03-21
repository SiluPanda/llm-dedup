"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const key_1 = require("../key");
(0, vitest_1.describe)('canonicalizeKey', () => {
    (0, vitest_1.it)('produces same hash for same params regardless of key order', () => {
        const a = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
        const b = (0, key_1.canonicalizeKey)({ temperature: 0.7, messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4' });
        (0, vitest_1.expect)(a).toBe(b);
    });
    (0, vitest_1.it)('produces different hashes for different models', () => {
        const a = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [] });
        const b = (0, key_1.canonicalizeKey)({ model: 'gpt-3.5-turbo', messages: [] });
        (0, vitest_1.expect)(a).not.toBe(b);
    });
    (0, vitest_1.it)('applies normalizer before hashing', () => {
        const normalizer = (text) => text.toLowerCase();
        const a = (0, key_1.canonicalizeKey)({ model: 'GPT-4', messages: [] }, normalizer);
        const b = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [] }, normalizer);
        // Normalizer lowercases, but model values are inside JSON strings so quoted
        // Both will produce the same normalized string → same hash
        // Actually model values in JSON are case-sensitive strings; normalizer applies to final JSON string
        // "GPT-4" lowercased → "gpt-4" → same as "gpt-4"
        (0, vitest_1.expect)(a).toBe(b);
    });
    (0, vitest_1.it)('ignores fields not in the relevant set', () => {
        const a = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [], user: 'alice', stream: true });
        const b = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [], user: 'bob', stream: false });
        (0, vitest_1.expect)(a).toBe(b);
    });
    (0, vitest_1.it)('includes temperature differences in the hash', () => {
        const a = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [], temperature: 0.0 });
        const b = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [], temperature: 1.0 });
        (0, vitest_1.expect)(a).not.toBe(b);
    });
    (0, vitest_1.it)('includes messages content in the hash', () => {
        const a = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] });
        const b = (0, key_1.canonicalizeKey)({ model: 'gpt-4', messages: [{ role: 'user', content: 'world' }] });
        (0, vitest_1.expect)(a).not.toBe(b);
    });
    (0, vitest_1.it)('handles Anthropic system field', () => {
        const a = (0, key_1.canonicalizeKey)({ model: 'claude-3', messages: [], system: 'You are helpful.' });
        const b = (0, key_1.canonicalizeKey)({ model: 'claude-3', messages: [], system: 'You are harmful.' });
        (0, vitest_1.expect)(a).not.toBe(b);
    });
    (0, vitest_1.it)('handles non-object params via _raw wrapping', () => {
        const a = (0, key_1.canonicalizeKey)('raw-string');
        const b = (0, key_1.canonicalizeKey)('raw-string');
        const c = (0, key_1.canonicalizeKey)('other-string');
        (0, vitest_1.expect)(a).toBe(b);
        (0, vitest_1.expect)(a).not.toBe(c);
    });
});
(0, vitest_1.describe)('sortedStringify', () => {
    (0, vitest_1.it)('sorts object keys alphabetically', () => {
        const result = (0, key_1.sortedStringify)({ z: 1, a: 2, m: 3 });
        (0, vitest_1.expect)(result).toBe('{"a":2,"m":3,"z":1}');
    });
    (0, vitest_1.it)('recursively sorts nested object keys', () => {
        const result = (0, key_1.sortedStringify)({ b: { y: 1, x: 2 }, a: 0 });
        (0, vitest_1.expect)(result).toBe('{"a":0,"b":{"x":2,"y":1}}');
    });
    (0, vitest_1.it)('preserves array order', () => {
        const result = (0, key_1.sortedStringify)([3, 1, 2]);
        (0, vitest_1.expect)(result).toBe('[3,1,2]');
    });
    (0, vitest_1.it)('handles primitives', () => {
        (0, vitest_1.expect)((0, key_1.sortedStringify)(42)).toBe('42');
        (0, vitest_1.expect)((0, key_1.sortedStringify)('hello')).toBe('"hello"');
        (0, vitest_1.expect)((0, key_1.sortedStringify)(null)).toBe('null');
        (0, vitest_1.expect)((0, key_1.sortedStringify)(true)).toBe('true');
    });
});
(0, vitest_1.describe)('hashString', () => {
    (0, vitest_1.it)('returns a 64-character hex string (SHA-256)', () => {
        const h = (0, key_1.hashString)('test');
        (0, vitest_1.expect)(h).toHaveLength(64);
        (0, vitest_1.expect)(h).toMatch(/^[0-9a-f]+$/);
    });
    (0, vitest_1.it)('is deterministic', () => {
        (0, vitest_1.expect)((0, key_1.hashString)('abc')).toBe((0, key_1.hashString)('abc'));
    });
    (0, vitest_1.it)('differs for different inputs', () => {
        (0, vitest_1.expect)((0, key_1.hashString)('abc')).not.toBe((0, key_1.hashString)('def'));
    });
});
//# sourceMappingURL=key.test.js.map