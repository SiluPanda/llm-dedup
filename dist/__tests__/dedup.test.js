"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const dedup_1 = require("../dedup");
const types_1 = require("../types");
(0, vitest_1.describe)('createDedup', () => {
    (0, vitest_1.describe)('coalescing', () => {
        (0, vitest_1.it)('calls fn once for identical concurrent calls and both get the same result', async () => {
            const dedup = (0, dedup_1.createDedup)();
            let callCount = 0;
            const fn = () => new Promise(resolve => {
                callCount++;
                setTimeout(() => resolve({ value: 42 }), 20);
            });
            const [r1, r2] = await Promise.all([
                dedup.execute('key1', fn),
                dedup.execute('key1', fn),
            ]);
            (0, vitest_1.expect)(callCount).toBe(1);
            (0, vitest_1.expect)(r1).toEqual({ value: 42 });
            (0, vitest_1.expect)(r2).toEqual({ value: 42 });
            await dedup.close();
        });
        (0, vitest_1.it)('calls fn independently for different keys', async () => {
            const dedup = (0, dedup_1.createDedup)();
            let callCount = 0;
            const makeValue = (v) => () => new Promise(resolve => {
                callCount++;
                setTimeout(() => resolve(v), 10);
            });
            const [r1, r2] = await Promise.all([
                dedup.execute('keyA', makeValue(10)),
                dedup.execute('keyB', makeValue(20)),
            ]);
            (0, vitest_1.expect)(callCount).toBe(2);
            (0, vitest_1.expect)(r1).toBe(10);
            (0, vitest_1.expect)(r2).toBe(20);
            await dedup.close();
        });
        (0, vitest_1.it)('increments stats.coalesced for subscriber requests', async () => {
            const dedup = (0, dedup_1.createDedup)();
            const fn = () => new Promise(resolve => setTimeout(() => resolve('done'), 20));
            await Promise.all([
                dedup.execute('k', fn),
                dedup.execute('k', fn),
                dedup.execute('k', fn),
            ]);
            const s = dedup.stats();
            (0, vitest_1.expect)(s.total).toBe(3);
            (0, vitest_1.expect)(s.unique).toBe(1);
            (0, vitest_1.expect)(s.coalesced).toBe(2);
            (0, vitest_1.expect)(s.coalescedRate).toBeCloseTo(2 / 3);
            await dedup.close();
        });
        (0, vitest_1.it)('subscribers get independent copies (structuredClone)', async () => {
            const dedup = (0, dedup_1.createDedup)();
            const fn = () => new Promise(resolve => setTimeout(() => resolve({ arr: [1, 2, 3] }), 20));
            const [r1, r2] = await Promise.all([
                dedup.execute('k', fn),
                dedup.execute('k', fn),
            ]);
            // Mutate one result; the other should be unaffected
            r1.arr.push(99);
            (0, vitest_1.expect)(r2.arr).toEqual([1, 2, 3]);
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('error propagation', () => {
        (0, vitest_1.it)('propagates fn errors to all subscribers', async () => {
            const dedup = (0, dedup_1.createDedup)();
            const boom = new Error('boom');
            const fn = () => new Promise((_, reject) => setTimeout(() => reject(boom), 20));
            const results = await Promise.allSettled([
                dedup.execute('err-key', fn),
                dedup.execute('err-key', fn),
                dedup.execute('err-key', fn),
            ]);
            for (const r of results) {
                (0, vitest_1.expect)(r.status).toBe('rejected');
                (0, vitest_1.expect)(r.reason).toBe(boom);
            }
            const s = dedup.stats();
            (0, vitest_1.expect)(s.errors).toBe(1);
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('cancelInflight', () => {
        (0, vitest_1.it)('rejects waiting subscribers with DedupCancelError', async () => {
            const dedup = (0, dedup_1.createDedup)();
            let resolveOwner;
            const fn = () => new Promise(resolve => { resolveOwner = resolve; });
            // Start owner + subscriber
            const ownerP = dedup.execute('cancel-key', fn);
            const subP = dedup.execute('cancel-key', fn);
            dedup.cancelInflight('cancel-key');
            const [subResult] = await Promise.allSettled([subP]);
            (0, vitest_1.expect)(subResult.status).toBe('rejected');
            (0, vitest_1.expect)(subResult.reason).toBeInstanceOf(types_1.DedupCancelError);
            (0, vitest_1.expect)(subResult.reason.key).toBe('cancel-key');
            // Resolve the owner fn to avoid hanging
            resolveOwner('late');
            await ownerP.catch(() => { });
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('close', () => {
        (0, vitest_1.it)('prevents new execute() calls after close', async () => {
            const dedup = (0, dedup_1.createDedup)();
            await dedup.close();
            await (0, vitest_1.expect)(dedup.execute('k', () => Promise.resolve(1))).rejects.toThrow('LLMDedup is closed');
        });
    });
    (0, vitest_1.describe)('timeout', () => {
        (0, vitest_1.it)('rejects subscriber with DedupTimeoutError when maxWaitMs exceeded (reject behavior)', async () => {
            const dedup = (0, dedup_1.createDedup)({ maxWaitMs: 50, timeoutBehavior: 'reject' });
            let resolveOwner;
            const fn = () => new Promise(resolve => { resolveOwner = resolve; });
            dedup.execute('t', fn); // owner, hangs
            const subP = dedup.execute('t', fn); // subscriber, will timeout
            const result = await Promise.allSettled([subP]);
            (0, vitest_1.expect)(result[0].status).toBe('rejected');
            const err = result[0].reason;
            (0, vitest_1.expect)(err).toBeInstanceOf(types_1.DedupTimeoutError);
            (0, vitest_1.expect)(err.code).toBe('DEDUP_TIMEOUT');
            (0, vitest_1.expect)(err.key).toBe('t');
            const s = dedup.stats();
            (0, vitest_1.expect)(s.timeouts).toBe(1);
            resolveOwner(0);
            await dedup.close();
        });
        (0, vitest_1.it)('falls through as new owner when timeoutBehavior is fallthrough', async () => {
            const dedup = (0, dedup_1.createDedup)({ maxWaitMs: 50, timeoutBehavior: 'fallthrough' });
            let callCount = 0;
            let resolveFirst;
            const slowFn = () => new Promise(resolve => {
                callCount++;
                if (callCount === 1) {
                    resolveFirst = resolve;
                }
                else {
                    setTimeout(() => resolve('fallthrough-result'), 10);
                }
            });
            const ownerP = dedup.execute('ft', slowFn);
            const subP = dedup.execute('ft', slowFn); // will timeout and fallthrough
            const subResult = await subP;
            (0, vitest_1.expect)(subResult).toBe('fallthrough-result');
            (0, vitest_1.expect)(callCount).toBe(2);
            resolveFirst('owner-result');
            await ownerP;
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('maxSubscribers', () => {
        (0, vitest_1.it)('excess subscribers become new owners when maxSubscribers is reached', async () => {
            const dedup = (0, dedup_1.createDedup)({ maxSubscribers: 2 });
            let callCount = 0;
            let resolveOwner;
            const fn = () => new Promise(resolve => {
                callCount++;
                if (callCount === 1) {
                    resolveOwner = resolve;
                }
                else {
                    resolve('overflow-result');
                }
            });
            // 1 owner + 2 subscribers (fills up) + 1 overflow that becomes new owner
            const p0 = dedup.execute('ms', fn); // owner
            const p1 = dedup.execute('ms', fn); // subscriber 1
            const p2 = dedup.execute('ms', fn); // subscriber 2 (maxSubscribers = 2, fills up)
            const p3 = dedup.execute('ms', fn); // overflow -> new owner
            resolveOwner('main-result');
            const [r0, r1, r2, r3] = await Promise.all([p0, p1, p2, p3]);
            (0, vitest_1.expect)(r0).toBe('main-result');
            (0, vitest_1.expect)(r1).toEqual('main-result');
            (0, vitest_1.expect)(r2).toEqual('main-result');
            (0, vitest_1.expect)(r3).toBe('overflow-result');
            (0, vitest_1.expect)(callCount).toBe(2);
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('getInflight', () => {
        (0, vitest_1.it)('returns inflight entries while a call is pending', async () => {
            const dedup = (0, dedup_1.createDedup)();
            let resolveIt;
            const fn = () => new Promise(resolve => { resolveIt = resolve; });
            const p = dedup.execute('inflight-key', fn);
            const inflight = dedup.getInflight();
            (0, vitest_1.expect)(inflight).toHaveLength(1);
            (0, vitest_1.expect)(inflight[0].key).toBe('inflight-key');
            (0, vitest_1.expect)(inflight[0].subscriberCount).toBe(0);
            (0, vitest_1.expect)(inflight[0].elapsedMs).toBeGreaterThanOrEqual(0);
            resolveIt(7);
            await p;
            (0, vitest_1.expect)(dedup.getInflight()).toHaveLength(0);
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('AbortSignal', () => {
        (0, vitest_1.it)('rejects immediately if signal is already aborted before execute()', async () => {
            const dedup = (0, dedup_1.createDedup)();
            const controller = new AbortController();
            controller.abort(new Error('pre-aborted'));
            await (0, vitest_1.expect)(dedup.execute('abort-pre', () => Promise.resolve(1), { signal: controller.signal })).rejects.toThrow('pre-aborted');
            await dedup.close();
        });
        (0, vitest_1.it)('rejects a waiting subscriber when the signal fires during wait', async () => {
            const dedup = (0, dedup_1.createDedup)({ maxWaitMs: 0 }); // disable timeout so only abort fires
            const controller = new AbortController();
            let resolveOwner;
            const fn = () => new Promise(resolve => { resolveOwner = resolve; });
            dedup.execute('abort-sub', fn); // owner — hangs
            const subP = dedup.execute('abort-sub', fn, { signal: controller.signal }); // subscriber
            controller.abort();
            const result = await Promise.allSettled([subP]);
            (0, vitest_1.expect)(result[0].status).toBe('rejected');
            resolveOwner(0);
            await dedup.close();
        });
        (0, vitest_1.it)('does not reject subscriber if signal fires after owner resolves', async () => {
            const dedup = (0, dedup_1.createDedup)({ maxWaitMs: 0 });
            const controller = new AbortController();
            const [r1, r2] = await Promise.all([
                dedup.execute('abort-done', () => new Promise(res => setTimeout(() => res(99), 20))),
                dedup.execute('abort-done', () => Promise.resolve(99), { signal: controller.signal }),
            ]);
            // Abort after both have resolved — should not throw
            controller.abort();
            (0, vitest_1.expect)(r1).toBe(99);
            (0, vitest_1.expect)(r2).toBe(99);
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('resetStats', () => {
        (0, vitest_1.it)('resets all counters to zero', async () => {
            const dedup = (0, dedup_1.createDedup)();
            const fn = () => Promise.resolve(1);
            await dedup.execute('r', fn);
            dedup.resetStats();
            const s = dedup.stats();
            (0, vitest_1.expect)(s.total).toBe(0);
            (0, vitest_1.expect)(s.unique).toBe(0);
            (0, vitest_1.expect)(s.coalesced).toBe(0);
            (0, vitest_1.expect)(s.errors).toBe(0);
            (0, vitest_1.expect)(s.timeouts).toBe(0);
            (0, vitest_1.expect)(s.peakInflight).toBe(0);
            await dedup.close();
        });
    });
    (0, vitest_1.describe)('race condition: concurrent timeout + resolution', () => {
        (0, vitest_1.it)('resolves all subscribers even when a timeout fires during owner settlement', async () => {
            // Use fallthrough so timeout triggers removeFromQueue (splice) on the
            // live subscribers array. Before the fix, for...of iteration over the
            // same array would skip adjacent subscribers, leaving their promises
            // hanging forever.
            const dedup = (0, dedup_1.createDedup)({ maxWaitMs: 30, timeoutBehavior: 'fallthrough' });
            let resolveOwner;
            // Owner hangs until we resolve manually
            const ownerFn = () => new Promise(resolve => { resolveOwner = resolve; });
            // Fallthrough fn returns immediately
            const fallthroughFn = () => Promise.resolve('fallthrough');
            const ownerP = dedup.execute('race', ownerFn);
            // Create 5 subscribers — enough that a splice-during-iteration would
            // skip at least one
            const subPromises = Array.from({ length: 5 }, () => dedup.execute('race', fallthroughFn));
            // Wait long enough for all subscriber timeouts to fire
            await new Promise(r => setTimeout(r, 80));
            // Now resolve the owner — remaining subscribers (if any) should also resolve
            resolveOwner('owner-done');
            // All 6 promises must settle within a bounded time. If any subscriber
            // was skipped, its promise would hang and this would timeout.
            const results = await Promise.allSettled([ownerP, ...subPromises]);
            for (const result of results) {
                (0, vitest_1.expect)(result.status).toBe('fulfilled');
            }
            (0, vitest_1.expect)(dedup.stats().currentInflight).toBe(0);
            await dedup.close();
        });
        (0, vitest_1.it)('does not double-decrement currentInflight when cancelInflight races with owner settlement', async () => {
            const dedup = (0, dedup_1.createDedup)();
            let resolveOwner;
            const fn = () => new Promise(resolve => { resolveOwner = resolve; });
            const ownerP = dedup.execute('dd', fn);
            const subP = dedup.execute('dd', fn); // subscriber
            // Cancel before owner settles — decrements currentInflight once
            dedup.cancelInflight('dd');
            // Now resolve the owner — should NOT decrement again
            resolveOwner('late');
            await Promise.allSettled([ownerP, subP]);
            // Wait a tick for any async settlement
            await new Promise(r => setTimeout(r, 10));
            const s = dedup.stats();
            (0, vitest_1.expect)(s.currentInflight).toBe(0);
            await dedup.close();
        });
    });
});
//# sourceMappingURL=dedup.test.js.map