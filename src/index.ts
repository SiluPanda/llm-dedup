// llm-dedup - Coalesce semantically similar in-flight LLM requests
export { createDedup } from './dedup'
export { canonicalizeKey, sortedStringify, hashString } from './key'
export type {
  LLMDedupOptions,
  InflightInfo,
  DedupStats,
  ExecuteOptions,
  LLMDedup,
} from './types'
export { DedupTimeoutError, DedupCancelError } from './types'
