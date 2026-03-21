# llm-dedup

Coalesce semantically similar in-flight LLM requests. When multiple callers fire the same request concurrently, only one upstream call is made — all callers receive the same result.

## Install

```bash
npm install llm-dedup
```

No external runtime dependencies.

## Quick start

```typescript
import { createDedup } from 'llm-dedup'

const dedup = createDedup({
  maxWaitMs: 30000,          // how long subscribers wait before timing out (default: 30000)
  timeoutBehavior: 'reject', // 'reject' | 'fallthrough' (default: 'reject')
  maxSubscribers: 100,       // max coalesced callers per in-flight request (default: 100)
  abandonTimeoutMs: 120000,  // auto-cancel stuck entries after this long (default: 120000)
})

// Two concurrent calls with the same key → only one fn() execution
const [r1, r2] = await Promise.all([
  dedup.execute('my-cache-key', () => callOpenAI(params)),
  dedup.execute('my-cache-key', () => callOpenAI(params)),
])
// r1 and r2 are independent deep copies of the same result
```

## Canonical key hashing

Use `canonicalizeKey` to derive a stable cache key from LLM request parameters. It extracts only the semantically-relevant fields (`messages`, `model`, `temperature`, `top_p`, `max_tokens`, `frequency_penalty`, `presence_penalty`, `seed`, `tools`, `tool_choice`, `response_format`, `stop`, `system`), sorts object keys recursively, and returns a SHA-256 hex digest.

```typescript
import { createDedup, canonicalizeKey } from 'llm-dedup'

const dedup = createDedup()

async function chat(params: OpenAIParams) {
  const key = canonicalizeKey(params)
  return dedup.execute(key, () => openai.chat.completions.create(params))
}
```

## Per-call options

```typescript
const result = await dedup.execute(key, fn, {
  maxWaitMs: 5000,   // override instance-level timeout for this call only
  signal: abortCtrl.signal, // AbortSignal (checked before execute)
})
```

## Observability

```typescript
// Current in-flight entries
dedup.getInflight()
// => [{ key, subscriberCount, elapsedMs, createdAt }]

// Aggregate stats
dedup.stats()
// => { total, unique, coalesced, coalescedRate, timeouts, errors, currentInflight, peakInflight }

dedup.resetStats()
```

## Cancellation

```typescript
// Cancel a specific in-flight request — rejects all waiting subscribers
dedup.cancelInflight('my-cache-key')

// Cancel everything
dedup.cancelAll()

// Shut down cleanly (cancels all, stops background timers)
await dedup.close()
```

## Error handling

If the owner `fn()` throws, the error propagates to all coalesced subscribers. Each subscriber receives the exact same error object.

```typescript
import { DedupTimeoutError, DedupCancelError } from 'llm-dedup'

try {
  await dedup.execute(key, fn)
} catch (err) {
  if (err instanceof DedupTimeoutError) {
    console.log('Waited too long:', err.waitedMs, 'ms for key:', err.key)
  }
  if (err instanceof DedupCancelError) {
    console.log('Request was cancelled for key:', err.key)
  }
}
```

## API

### `createDedup(options?): LLMDedup`

| Option | Type | Default | Description |
|---|---|---|---|
| `maxWaitMs` | `number` | `30000` | Max ms a subscriber waits before timeout |
| `timeoutBehavior` | `'reject' \| 'fallthrough'` | `'reject'` | On timeout: reject with `DedupTimeoutError` or re-run `fn()` as new owner |
| `maxSubscribers` | `number` | `100` | Max coalesced callers per inflight entry; excess become new owners |
| `abandonTimeoutMs` | `number` | `120000` | Auto-cancel stuck entries older than this |
| `tokenEstimator` | `(text) => number` | `text.length/4` | Custom token estimator (reserved for future use) |
| `normalizer` | `(text) => string` | `undefined` | Applied to canonical JSON string before hashing |
| `logger` | `{ warn, debug? }` | `undefined` | Optional logger |

### `dedup.execute(key, fn, options?): Promise<T>`

Run `fn()` or join an existing in-flight call for `key`. Subscribers receive a `structuredClone` of the owner's result.

### `canonicalizeKey(params, normalizer?): string`

Derive a stable SHA-256 key from LLM request parameters.

## License

MIT
