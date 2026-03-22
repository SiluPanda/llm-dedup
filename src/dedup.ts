import { InflightRegistry, InflightEntry } from './registry'
import {
  LLMDedupOptions,
  LLMDedup,
  InflightInfo,
  DedupStats,
  ExecuteOptions,
  DedupTimeoutError,
  DedupCancelError,
} from './types'

export function createDedup(options?: LLMDedupOptions): LLMDedup {
  const registry = new InflightRegistry()
  const opts = {
    maxWaitMs: 30000,
    timeoutBehavior: 'reject' as 'reject' | 'fallthrough',
    maxSubscribers: 100,
    abandonTimeoutMs: 120000,
    ...options,
  }

  const rawStats = {
    total: 0,
    unique: 0,
    coalesced: 0,
    timeouts: 0,
    errors: 0,
    currentInflight: 0,
    peakInflight: 0,
  }

  let closed = false
  let abandonTimer: ReturnType<typeof setInterval> | null = null

  abandonTimer = setInterval(() => {
    const now = Date.now()
    for (const entry of registry.all()) {
      if (!entry.settled && now - entry.createdAt > opts.abandonTimeoutMs) {
        const err = new DedupCancelError(entry.key)
        for (const sub of entry.subscribers) {
          clearTimeout(sub.timeoutTimer)
          sub.abortCleanup?.()
          sub.reject(err)
        }
        entry.settled = true
        registry.delete(entry.key)
        rawStats.currentInflight = Math.max(0, rawStats.currentInflight - 1)
      }
    }
  }, Math.min(opts.abandonTimeoutMs / 2, 60000))

  if (abandonTimer.unref) {
    abandonTimer.unref()
  }

  function execute<T>(key: string, fn: () => Promise<T>, executeOptions?: ExecuteOptions): Promise<T> {
    rawStats.total++

    if (closed) {
      return Promise.reject(new Error('LLMDedup is closed'))
    }

    const signal = executeOptions?.signal
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('AbortError', 'AbortError'))
    }

    const existing = registry.get<T>(key)
    if (existing && !existing.settled) {
      // SUBSCRIBER MODE
      if (existing.subscribers.length >= opts.maxSubscribers) {
        // Too many subscribers — become a new owner with a unique key
        const overflowKey = key + '-overflow-' + rawStats.total
        rawStats.unique++
        rawStats.currentInflight++
        rawStats.peakInflight = Math.max(rawStats.peakInflight, rawStats.currentInflight)

        const overflowEntry: InflightEntry<T> = {
          key: overflowKey,
          promise: null!,
          subscribers: [],
          createdAt: Date.now(),
          settled: false,
        }
        registry.set(overflowKey, overflowEntry)

        const overflowPromise = (async () => {
          try {
            const result = await fn()
            overflowEntry.settled = true
            registry.delete(overflowKey)
            rawStats.currentInflight = Math.max(0, rawStats.currentInflight - 1)
            for (const sub of overflowEntry.subscribers) {
              clearTimeout(sub.timeoutTimer)
              sub.abortCleanup?.()
              try {
                sub.resolve(structuredClone(result))
              } catch {
                sub.resolve(result)
              }
            }
            return result
          } catch (err) {
            overflowEntry.settled = true
            registry.delete(overflowKey)
            rawStats.currentInflight = Math.max(0, rawStats.currentInflight - 1)
            rawStats.errors++
            for (const sub of overflowEntry.subscribers) {
              clearTimeout(sub.timeoutTimer)
              sub.abortCleanup?.()
              sub.reject(err)
            }
            throw err
          }
        })()

        overflowEntry.promise = overflowPromise
        return overflowPromise
      }

      rawStats.coalesced++
      return new Promise<T>((resolve, reject) => {
        const maxWait = executeOptions?.maxWaitMs ?? opts.maxWaitMs

        const subscriber: {
          resolve: (v: T) => void
          reject: (e: unknown) => void
          timeoutTimer?: ReturnType<typeof setTimeout>
          abortCleanup?: () => void
        } = {
          resolve,
          reject,
          timeoutTimer: undefined,
          abortCleanup: undefined,
        }

        const removeFromQueue = () => {
          const idx = existing.subscribers.indexOf(subscriber)
          if (idx !== -1) {
            existing.subscribers.splice(idx, 1)
          }
        }

        if (signal) {
          const onAbort = () => {
            removeFromQueue()
            clearTimeout(subscriber.timeoutTimer)
            reject(signal.reason ?? new DOMException('AbortError', 'AbortError'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          subscriber.abortCleanup = () => signal.removeEventListener('abort', onAbort)
        }

        if (maxWait > 0) {
          subscriber.timeoutTimer = setTimeout(() => {
            removeFromQueue()
            subscriber.abortCleanup?.()
            rawStats.timeouts++
            if (opts.timeoutBehavior === 'fallthrough') {
              fn().then(resolve, reject)
            } else {
              reject(new DedupTimeoutError(key, maxWait))
            }
          }, maxWait)
        }

        existing.subscribers.push(subscriber)
      })
    }

    // OWNER MODE
    rawStats.unique++
    rawStats.currentInflight++
    rawStats.peakInflight = Math.max(rawStats.peakInflight, rawStats.currentInflight)

    const entry: InflightEntry<T> = {
      key,
      promise: null!,
      subscribers: [],
      createdAt: Date.now(),
      settled: false,
    }
    registry.set(key, entry)

    const ownerPromise = (async () => {
      try {
        const result = await fn()
        entry.settled = true
        registry.delete(key)
        rawStats.currentInflight = Math.max(0, rawStats.currentInflight - 1)
        for (const sub of entry.subscribers) {
          clearTimeout(sub.timeoutTimer)
          sub.abortCleanup?.()
          try {
            sub.resolve(structuredClone(result))
          } catch {
            sub.resolve(result)
          }
        }
        return result
      } catch (err) {
        entry.settled = true
        registry.delete(key)
        rawStats.currentInflight = Math.max(0, rawStats.currentInflight - 1)
        rawStats.errors++
        for (const sub of entry.subscribers) {
          clearTimeout(sub.timeoutTimer)
          sub.abortCleanup?.()
          sub.reject(err)
        }
        throw err
      }
    })()

    entry.promise = ownerPromise
    return ownerPromise
  }

  function getInflight(): InflightInfo[] {
    return registry.all().map(e => ({
      key: e.key,
      subscriberCount: e.subscribers.length,
      elapsedMs: Date.now() - e.createdAt,
      createdAt: e.createdAt,
    }))
  }

  function stats(): DedupStats {
    return {
      total: rawStats.total,
      unique: rawStats.unique,
      coalesced: rawStats.coalesced,
      coalescedRate: rawStats.coalesced / Math.max(1, rawStats.total),
      timeouts: rawStats.timeouts,
      errors: rawStats.errors,
      currentInflight: rawStats.currentInflight,
      peakInflight: rawStats.peakInflight,
    }
  }

  function resetStats(): void {
    rawStats.total = 0
    rawStats.unique = 0
    rawStats.coalesced = 0
    rawStats.timeouts = 0
    rawStats.errors = 0
    rawStats.currentInflight = 0
    rawStats.peakInflight = 0
  }

  function cancelInflight(key: string): void {
    const entry = registry.get(key)
    if (!entry) return
    const err = new DedupCancelError(key)
    for (const sub of entry.subscribers) {
      clearTimeout(sub.timeoutTimer)
      sub.abortCleanup?.()
      sub.reject(err)
    }
    entry.settled = true
    registry.delete(key)
    rawStats.currentInflight = Math.max(0, rawStats.currentInflight - 1)
  }

  function cancelAll(): void {
    for (const entry of registry.all()) {
      cancelInflight(entry.key)
    }
  }

  async function close(): Promise<void> {
    closed = true
    if (abandonTimer !== null) {
      clearInterval(abandonTimer)
      abandonTimer = null
    }
    cancelAll()
  }

  return {
    execute,
    getInflight,
    stats,
    resetStats,
    cancelInflight,
    cancelAll,
    close,
  }
}
