"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DedupCancelError = exports.DedupTimeoutError = void 0;
class DedupTimeoutError extends Error {
    key;
    waitedMs;
    code = 'DEDUP_TIMEOUT';
    constructor(key, waitedMs) {
        super(`Dedup timeout after ${waitedMs}ms for key: ${key}`);
        this.key = key;
        this.waitedMs = waitedMs;
        this.name = 'DedupTimeoutError';
    }
}
exports.DedupTimeoutError = DedupTimeoutError;
class DedupCancelError extends Error {
    key;
    code = 'DEDUP_CANCEL';
    constructor(key) {
        super(`Dedup request cancelled for key: ${key}`);
        this.key = key;
        this.name = 'DedupCancelError';
    }
}
exports.DedupCancelError = DedupCancelError;
//# sourceMappingURL=types.js.map