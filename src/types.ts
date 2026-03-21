export interface LLMDedupOptions {
  maxWaitMs?: number
  timeoutBehavior?: 'reject' | 'fallthrough'
  maxSubscribers?: number
  abandonTimeoutMs?: number
  tokenEstimator?: (text: string) => number
  normalizer?: (text: string) => string
  logger?: { warn: (m: string) => void; debug?: (m: string) => void }
}

export interface InflightInfo {
  key: string
  subscriberCount: number
  elapsedMs: number
  createdAt: number
}

export interface DedupStats {
  total: number
  unique: number
  coalesced: number
  coalescedRate: number
  timeouts: number
  errors: number
  currentInflight: number
  peakInflight: number
}

export interface ExecuteOptions {
  signal?: AbortSignal
  maxWaitMs?: number
}

export interface LLMDedup {
  execute<T>(key: string, fn: () => Promise<T>, options?: ExecuteOptions): Promise<T>
  getInflight(): InflightInfo[]
  stats(): DedupStats
  resetStats(): void
  cancelInflight(key: string): void
  cancelAll(): void
  close(): Promise<void>
}

export class DedupTimeoutError extends Error {
  readonly code = 'DEDUP_TIMEOUT'
  constructor(readonly key: string, readonly waitedMs: number) {
    super(`Dedup timeout after ${waitedMs}ms for key: ${key}`)
    this.name = 'DedupTimeoutError'
  }
}

export class DedupCancelError extends Error {
  readonly code = 'DEDUP_CANCEL'
  constructor(readonly key: string) {
    super(`Dedup request cancelled for key: ${key}`)
    this.name = 'DedupCancelError'
  }
}
