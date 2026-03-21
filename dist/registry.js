"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InflightRegistry = void 0;
class InflightRegistry {
    entries = new Map();
    has(key) {
        return this.entries.has(key);
    }
    get(key) {
        return this.entries.get(key);
    }
    set(key, entry) {
        this.entries.set(key, entry);
    }
    delete(key) {
        this.entries.delete(key);
    }
    size() {
        return this.entries.size;
    }
    all() {
        return Array.from(this.entries.values());
    }
    clear() {
        this.entries.clear();
    }
}
exports.InflightRegistry = InflightRegistry;
//# sourceMappingURL=registry.js.map