import { describe, it, expect } from 'vitest'
import { createDedup } from '../dedup'
import { DedupCancelError, DedupTimeoutError } from '../types'

describe('createDedup', () => {
  describe('coalescing', () => {
    it('calls fn once for identical concurrent calls and both get the same result', async () => {
      const dedup = createDedup()
      let callCount = 0
      const fn = () =>
        new Promise<{ value: number }>(resolve => {
          callCount++
          setTimeout(() => resolve({ value: 42 }), 20)
        })

      const [r1, r2] = await Promise.all([
        dedup.execute('key1', fn),
        dedup.execute('key1', fn),
      ])

      expect(callCount).toBe(1)
      expect(r1).toEqual({ value: 42 })
      expect(r2).toEqual({ value: 42 })

      await dedup.close()
    })

    it('calls fn independently for different keys', async () => {
      const dedup = createDedup()
      let callCount = 0
      const makeValue = (v: number) => () =>
        new Promise<number>(resolve => {
          callCount++
          setTimeout(() => resolve(v), 10)
        })

      const [r1, r2] = await Promise.all([
        dedup.execute('keyA', makeValue(10)),
        dedup.execute('keyB', makeValue(20)),
      ])

      expect(callCount).toBe(2)
      expect(r1).toBe(10)
      expect(r2).toBe(20)

      await dedup.close()
    })

    it('increments stats.coalesced for subscriber requests', async () => {
      const dedup = createDedup()
      const fn = () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 20))

      await Promise.all([
        dedup.execute('k', fn),
        dedup.execute('k', fn),
        dedup.execute('k', fn),
      ])

      const s = dedup.stats()
      expect(s.total).toBe(3)
      expect(s.unique).toBe(1)
      expect(s.coalesced).toBe(2)
      expect(s.coalescedRate).toBeCloseTo(2 / 3)

      await dedup.close()
    })

    it('subscribers get independent copies (structuredClone)', async () => {
      const dedup = createDedup()
      const fn = () => new Promise<{ arr: number[] }>(resolve => setTimeout(() => resolve({ arr: [1, 2, 3] }), 20))

      const [r1, r2] = await Promise.all([
        dedup.execute('k', fn),
        dedup.execute('k', fn),
      ])

      // Mutate one result; the other should be unaffected
      r1.arr.push(99)
      expect(r2.arr).toEqual([1, 2, 3])

      await dedup.close()
    })
  })

  describe('error propagation', () => {
    it('propagates fn errors to all subscribers', async () => {
      const dedup = createDedup()
      const boom = new Error('boom')
      const fn = () => new Promise<never>((_, reject) => setTimeout(() => reject(boom), 20))

      const results = await Promise.allSettled([
        dedup.execute('err-key', fn),
        dedup.execute('err-key', fn),
        dedup.execute('err-key', fn),
      ])

      for (const r of results) {
        expect(r.status).toBe('rejected')
        expect((r as PromiseRejectedResult).reason).toBe(boom)
      }

      const s = dedup.stats()
      expect(s.errors).toBe(1)

      await dedup.close()
    })
  })

  describe('cancelInflight', () => {
    it('rejects waiting subscribers with DedupCancelError', async () => {
      const dedup = createDedup()
      let resolveOwner!: (v: string) => void
      const fn = () => new Promise<string>(resolve => { resolveOwner = resolve })

      // Start owner + subscriber
      const ownerP = dedup.execute('cancel-key', fn)
      const subP = dedup.execute('cancel-key', fn)

      dedup.cancelInflight('cancel-key')

      const [subResult] = await Promise.allSettled([subP])
      expect(subResult.status).toBe('rejected')
      expect((subResult as PromiseRejectedResult).reason).toBeInstanceOf(DedupCancelError)
      expect(((subResult as PromiseRejectedResult).reason as DedupCancelError).key).toBe('cancel-key')

      // Resolve the owner fn to avoid hanging
      resolveOwner('late')
      await ownerP.catch(() => {})

      await dedup.close()
    })
  })

  describe('close', () => {
    it('prevents new execute() calls after close', async () => {
      const dedup = createDedup()
      await dedup.close()

      await expect(dedup.execute('k', () => Promise.resolve(1))).rejects.toThrow('LLMDedup is closed')
    })
  })

  describe('timeout', () => {
    it('rejects subscriber with DedupTimeoutError when maxWaitMs exceeded (reject behavior)', async () => {
      const dedup = createDedup({ maxWaitMs: 50, timeoutBehavior: 'reject' })
      let resolveOwner!: (v: number) => void
      const fn = () => new Promise<number>(resolve => { resolveOwner = resolve })

      dedup.execute('t', fn) // owner, hangs
      const subP = dedup.execute('t', fn) // subscriber, will timeout

      const result = await Promise.allSettled([subP])
      expect(result[0].status).toBe('rejected')
      const err = (result[0] as PromiseRejectedResult).reason as DedupTimeoutError
      expect(err).toBeInstanceOf(DedupTimeoutError)
      expect(err.code).toBe('DEDUP_TIMEOUT')
      expect(err.key).toBe('t')

      const s = dedup.stats()
      expect(s.timeouts).toBe(1)

      resolveOwner(0)
      await dedup.close()
    })

    it('falls through as new owner when timeoutBehavior is fallthrough', async () => {
      const dedup = createDedup({ maxWaitMs: 50, timeoutBehavior: 'fallthrough' })
      let callCount = 0
      let resolveFirst!: (v: string) => void

      const slowFn = () =>
        new Promise<string>(resolve => {
          callCount++
          if (callCount === 1) {
            resolveFirst = resolve
          } else {
            setTimeout(() => resolve('fallthrough-result'), 10)
          }
        })

      const ownerP = dedup.execute('ft', slowFn)
      const subP = dedup.execute('ft', slowFn) // will timeout and fallthrough

      const subResult = await subP
      expect(subResult).toBe('fallthrough-result')
      expect(callCount).toBe(2)

      resolveFirst('owner-result')
      await ownerP

      await dedup.close()
    })
  })

  describe('maxSubscribers', () => {
    it('excess subscribers become new owners when maxSubscribers is reached', async () => {
      const dedup = createDedup({ maxSubscribers: 2 })
      let callCount = 0
      let resolveOwner!: (v: string) => void

      const fn = () =>
        new Promise<string>(resolve => {
          callCount++
          if (callCount === 1) {
            resolveOwner = resolve
          } else {
            resolve('overflow-result')
          }
        })

      // 1 owner + 2 subscribers (fills up) + 1 overflow that becomes new owner
      const p0 = dedup.execute('ms', fn) // owner
      const p1 = dedup.execute('ms', fn) // subscriber 1
      const p2 = dedup.execute('ms', fn) // subscriber 2 (maxSubscribers = 2, fills up)
      const p3 = dedup.execute('ms', fn) // overflow -> new owner

      resolveOwner('main-result')
      const [r0, r1, r2, r3] = await Promise.all([p0, p1, p2, p3])

      expect(r0).toBe('main-result')
      expect(r1).toEqual('main-result')
      expect(r2).toEqual('main-result')
      expect(r3).toBe('overflow-result')
      expect(callCount).toBe(2)

      await dedup.close()
    })
  })

  describe('getInflight', () => {
    it('returns inflight entries while a call is pending', async () => {
      const dedup = createDedup()
      let resolveIt!: (v: number) => void
      const fn = () => new Promise<number>(resolve => { resolveIt = resolve })

      const p = dedup.execute('inflight-key', fn)
      const inflight = dedup.getInflight()

      expect(inflight).toHaveLength(1)
      expect(inflight[0].key).toBe('inflight-key')
      expect(inflight[0].subscriberCount).toBe(0)
      expect(inflight[0].elapsedMs).toBeGreaterThanOrEqual(0)

      resolveIt(7)
      await p
      expect(dedup.getInflight()).toHaveLength(0)

      await dedup.close()
    })
  })

  describe('resetStats', () => {
    it('resets all counters to zero', async () => {
      const dedup = createDedup()
      const fn = () => Promise.resolve(1)
      await dedup.execute('r', fn)

      dedup.resetStats()
      const s = dedup.stats()
      expect(s.total).toBe(0)
      expect(s.unique).toBe(0)
      expect(s.coalesced).toBe(0)
      expect(s.errors).toBe(0)
      expect(s.timeouts).toBe(0)
      expect(s.peakInflight).toBe(0)

      await dedup.close()
    })
  })
})
