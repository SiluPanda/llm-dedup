# llm-dedup

Coalesce identical in-flight LLM requests into a single upstream call.

[![npm version](https://img.shields.io/npm/v/llm-dedup.svg)](https://www.npmjs.com/package/llm-dedup)
[![npm downloads](https://img.shields.io/npm/dt/llm-dedup.svg)](https://www.npmjs.com/package/llm-dedup)
[![license](https://img.shields.io/npm/l/llm-dedup.svg)](https://github.com/SiluPanda/llm-dedup/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/llm-dedup.svg)](https://nodejs.org)

---

## Description

`llm-dedup` is an in-flight request coalescing layer for LLM APIs. When multiple callers fire the same request concurrently, only one upstream call is made -- all callers receive an independent deep copy of the same result. This eliminates the thundering herd problem (also known as cache stampede or dogpile effect) that occurs when many identical requests arrive before any response exists in a cache.

The pattern is analogous to Go's `singleflight.Do`: the first caller for a given key becomes the **owner** and executes the actual LLM call; subsequent callers with the same key become **subscribers** and wait for the owner's result. When the owner's Promise settles, all subscribers are resolved (or rejected) with a `structuredClone` of the result, and the registry entry is removed immediately. The registry is entirely ephemeral -- entries exist only for the duration of an in-flight request (typically 1--30 seconds) and are never persisted.

Key characteristics:

- Zero runtime dependencies.
- Sub-millisecond overhead per dedup check (SHA-256 hash + Map lookup).
- Deep cloning of responses prevents mutation across subscribers.
- Configurable timeout, cancellation, and overflow behaviors.
- Background sweep automatically cancels abandoned entries.
- Built-in statistics for monitoring coalescing effectiveness.

---

## Installation

```bash
npm install llm-dedup
```

Requires Node.js 18 or later. No external runtime dependencies.

---

## Quick Start

```typescript
import { createDedup, canonicalizeKey } from 'llm-dedup';

const dedup = createDedup();

async function chat(params: Record<string, unknown>) {
  const key = canonicalizeKey(params);
  return dedup.execute(key, () => openai.chat.completions.create(params));
}

// Two concurrent calls with the same parameters produce one upstream call.
const [r1, r2] = await Promise.all([
  chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] }),
  chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] }),
]);
// r1 and r2 are deep-equal but reference-distinct copies of the same result.

// Always close when shutting down to clear background timers.
await dedup.close();
```

---

## Features

- **Request coalescing** -- Concurrent identical requests share a single upstream call. The first caller executes; all others subscribe.
- **Canonical key hashing** -- `canonicalizeKey` extracts only semantically relevant LLM parameters (`messages`, `model`, `temperature`, `top_p`, `max_tokens`, `frequency_penalty`, `presence_penalty`, `seed`, `tools`, `tool_choice`, `response_format`, `stop`, `system`), sorts object keys recursively, and returns a deterministic SHA-256 hex digest. Fields like `stream`, `user`, and `api_key` are excluded.
- **Deep clone isolation** -- Each subscriber receives a `structuredClone` of the owner's result, preventing cross-caller mutation.
- **Subscriber timeout** -- Subscribers that wait longer than `maxWaitMs` are detached. In `reject` mode, the subscriber's Promise rejects with `DedupTimeoutError`. In `fallthrough` mode, the subscriber re-executes `fn()` independently.
- **Per-call timeout override** -- Each `execute` call can override the instance-level `maxWaitMs` via `ExecuteOptions`.
- **Subscriber overflow** -- When an in-flight entry reaches `maxSubscribers`, additional callers bypass coalescing and execute their own upstream call.
- **Cancellation** -- Cancel a specific in-flight entry or all entries. Subscribers receive `DedupCancelError`.
- **Abandon sweep** -- A background interval automatically cancels entries that exceed `abandonTimeoutMs`, preventing leaked entries from hung upstream calls.
- **Statistics** -- Track total requests, unique executions, coalesced count, coalesced rate, timeouts, errors, current in-flight count, and peak in-flight count.
- **Custom normalizer** -- Apply a text transformation to the canonical JSON string before hashing, enabling custom matching logic (case folding, whitespace collapsing, etc.).
- **TypeScript-first** -- Full type declarations shipped in the package.

---

## API Reference

### `createDedup(options?): LLMDedup`

Factory function that creates and returns an `LLMDedup` instance.

```typescript
import { createDedup } from 'llm-dedup';

const dedup = createDedup({
  maxWaitMs: 30000,
  timeoutBehavior: 'reject',
  maxSubscribers: 100,
  abandonTimeoutMs: 120000,
});
```

#### Options (`LLMDedupOptions`)

| Option | Type | Default | Description |
|---|---|---|---|
| `maxWaitMs` | `number` | `30000` | Maximum milliseconds a subscriber waits before timeout. Set to `0` to disable subscriber timeouts. |
| `timeoutBehavior` | `'reject' \| 'fallthrough'` | `'reject'` | On timeout: reject with `DedupTimeoutError`, or re-execute `fn()` as an independent call. |
| `maxSubscribers` | `number` | `100` | Maximum coalesced callers per in-flight entry. Excess callers become independent owners. |
| `abandonTimeoutMs` | `number` | `120000` | Entries older than this are automatically cancelled by the background sweep. |
| `tokenEstimator` | `(text: string) => number` | `undefined` | Custom token estimation function. |
| `normalizer` | `(text: string) => string` | `undefined` | Applied to the canonical JSON string before SHA-256 hashing. |
| `logger` | `{ warn: (m: string) => void; debug?: (m: string) => void }` | `undefined` | Optional logger for warnings and debug messages. |

#### Return Value (`LLMDedup`)

The returned object exposes the following methods:

| Method | Signature | Description |
|---|---|---|
| `execute` | `<T>(key: string, fn: () => Promise<T>, options?: ExecuteOptions) => Promise<T>` | Run `fn()` or join an existing in-flight call for `key`. |
| `getInflight` | `() => InflightInfo[]` | Return metadata for all currently in-flight entries. |
| `stats` | `() => DedupStats` | Return aggregate dedup statistics. |
| `resetStats` | `() => void` | Reset all cumulative statistics to zero. |
| `cancelInflight` | `(key: string) => void` | Cancel a specific in-flight entry, rejecting all subscribers. |
| `cancelAll` | `() => void` | Cancel all in-flight entries. |
| `close` | `() => Promise<void>` | Cancel all entries, stop background timers, and mark the instance as closed. |

---

### `execute<T>(key, fn, options?)`

The core method. If no in-flight entry exists for `key`, `fn()` is called and the caller becomes the owner. If an in-flight entry already exists, the caller subscribes and receives a `structuredClone` of the owner's result when it settles.

```typescript
const result = await dedup.execute('my-key', async () => {
  return await llmClient.chat.completions.create(params);
});
```

#### `ExecuteOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | `undefined` | An `AbortSignal` for caller-side cancellation. |
| `maxWaitMs` | `number` | Instance default | Override the instance-level subscriber timeout for this call. |

---

### `canonicalizeKey(params, normalizer?): string`

Derive a deterministic SHA-256 hex key from LLM request parameters.

The function extracts only output-affecting fields (`messages`, `model`, `temperature`, `top_p`, `max_tokens`, `frequency_penalty`, `presence_penalty`, `seed`, `tools`, `tool_choice`, `response_format`, `stop`, `system`) from the input object, recursively sorts all object keys, and computes a SHA-256 hash. Fields like `stream`, `user`, `api_key`, and `request_id` are excluded, so requests that differ only in non-semantic fields produce the same key.

If `params` is not a plain object (e.g., a raw string), it is wrapped under a `_raw` key before hashing.

```typescript
import { canonicalizeKey } from 'llm-dedup';

const key = canonicalizeKey({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0.7,
  stream: true,  // ignored
  user: 'alice', // ignored
});
```

#### Parameters

| Parameter | Type | Description |
|---|---|---|
| `params` | `unknown` | The LLM request parameters object (or any value). |
| `normalizer` | `(text: string) => string` | Optional. Applied to the canonical JSON string before hashing. |

#### Returns

A 64-character lowercase hexadecimal SHA-256 digest string.

---

### `sortedStringify(value): string`

Recursively serialize a value to a JSON string with all object keys sorted alphabetically. Arrays preserve their element order. This is the serialization step used internally by `canonicalizeKey`.

```typescript
import { sortedStringify } from 'llm-dedup';

sortedStringify({ z: 1, a: 2, m: 3 });
// '{"a":2,"m":3,"z":1}'

sortedStringify({ b: { y: 1, x: 2 }, a: 0 });
// '{"a":0,"b":{"x":2,"y":1}}'
```

---

### `hashString(text): string`

Compute a SHA-256 hash of the input string and return it as a 64-character lowercase hex digest.

```typescript
import { hashString } from 'llm-dedup';

hashString('test');
// '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
```

---

### `DedupTimeoutError`

Thrown (or used to reject a subscriber's Promise) when a subscriber exceeds the configured `maxWaitMs` and `timeoutBehavior` is `'reject'`.

| Property | Type | Description |
|---|---|---|
| `name` | `string` | `'DedupTimeoutError'` |
| `code` | `string` | `'DEDUP_TIMEOUT'` |
| `key` | `string` | The dedup key that timed out. |
| `waitedMs` | `number` | How long the subscriber waited before timeout. |
| `message` | `string` | `'Dedup timeout after {waitedMs}ms for key: {key}'` |

---

### `DedupCancelError`

Thrown (or used to reject a subscriber's Promise) when an in-flight entry is cancelled via `cancelInflight`, `cancelAll`, `close`, or the abandon sweep.

| Property | Type | Description |
|---|---|---|
| `name` | `string` | `'DedupCancelError'` |
| `code` | `string` | `'DEDUP_CANCEL'` |
| `key` | `string` | The dedup key that was cancelled. |
| `message` | `string` | `'Dedup request cancelled for key: {key}'` |

---

### `DedupStats`

Returned by `dedup.stats()`.

| Field | Type | Description |
|---|---|---|
| `total` | `number` | Total number of `execute` calls. |
| `unique` | `number` | Number of calls that became owners (executed `fn`). |
| `coalesced` | `number` | Number of calls that subscribed to an existing in-flight entry. |
| `coalescedRate` | `number` | `coalesced / total` (0 when `total` is 0). |
| `timeouts` | `number` | Number of subscriber timeouts. |
| `errors` | `number` | Number of owner `fn` rejections. |
| `currentInflight` | `number` | Number of currently in-flight entries. |
| `peakInflight` | `number` | Highest number of concurrent in-flight entries observed. |

---

### `InflightInfo`

Returned by `dedup.getInflight()` for each in-flight entry.

| Field | Type | Description |
|---|---|---|
| `key` | `string` | The dedup key. |
| `subscriberCount` | `number` | Number of subscribers currently waiting. |
| `elapsedMs` | `number` | Milliseconds since the owner registered. |
| `createdAt` | `number` | Unix timestamp (ms) when the owner registered. |

---

## Configuration

### Timeout Behavior

When a subscriber waits longer than `maxWaitMs`, the behavior depends on the `timeoutBehavior` setting:

**`'reject'` (default)** -- The subscriber's Promise rejects with a `DedupTimeoutError`. The caller is responsible for handling the error (e.g., retrying).

```typescript
const dedup = createDedup({ maxWaitMs: 5000, timeoutBehavior: 'reject' });
```

**`'fallthrough'`** -- The subscriber detaches and re-executes `fn()` independently. This is useful when you want a best-effort dedup that never blocks callers beyond the timeout window.

```typescript
const dedup = createDedup({ maxWaitMs: 5000, timeoutBehavior: 'fallthrough' });
```

### Subscriber Overflow

When the number of subscribers on a single in-flight entry reaches `maxSubscribers`, additional callers bypass coalescing and execute `fn()` as independent owners. This prevents a single slow request from accumulating an unbounded number of waiting callers.

```typescript
const dedup = createDedup({ maxSubscribers: 50 });
```

### Abandon Sweep

A background `setInterval` runs at half the `abandonTimeoutMs` interval (capped at 60 seconds). Entries older than `abandonTimeoutMs` are automatically cancelled, and their subscribers receive `DedupCancelError`. The timer is unreffed so it does not prevent Node.js process exit.

```typescript
const dedup = createDedup({ abandonTimeoutMs: 60000 });
```

### Custom Normalizer

Apply a transformation to the canonical JSON string before hashing. This can increase match rates for requests that differ only in non-semantic ways (e.g., case differences in model names).

```typescript
const dedup = createDedup({
  normalizer: (text) => text.toLowerCase(),
});
```

The normalizer can also be passed directly to `canonicalizeKey`:

```typescript
const key = canonicalizeKey(params, (text) => text.toLowerCase());
```

---

## Error Handling

### Owner errors propagate to all subscribers

If the owner's `fn()` rejects, the same error is propagated to every subscriber. Each subscriber's Promise rejects with the original error object.

```typescript
try {
  await dedup.execute(key, fn);
} catch (err) {
  // This error is the same whether this caller was the owner or a subscriber.
}
```

### Typed error classes

Use `instanceof` checks to distinguish dedup-specific errors from upstream LLM errors:

```typescript
import { DedupTimeoutError, DedupCancelError } from 'llm-dedup';

try {
  await dedup.execute(key, fn);
} catch (err) {
  if (err instanceof DedupTimeoutError) {
    console.log(`Timed out after ${err.waitedMs}ms for key: ${err.key}`);
    console.log(`Error code: ${err.code}`); // 'DEDUP_TIMEOUT'
  } else if (err instanceof DedupCancelError) {
    console.log(`Cancelled for key: ${err.key}`);
    console.log(`Error code: ${err.code}`); // 'DEDUP_CANCEL'
  } else {
    // Upstream LLM error from the owner's fn()
    throw err;
  }
}
```

### Closed instance

Calling `execute` after `close()` immediately rejects with `Error('LLMDedup is closed')`.

---

## Advanced Usage

### Layering with a response cache

`llm-dedup` is complementary to response caching. The cache handles sequential duplicates (same request minutes apart); `llm-dedup` handles concurrent duplicates (same request within the same response window). Layer dedup on top of the cache so that concurrent cache misses for the same prompt result in a single upstream call:

```typescript
import { createDedup, canonicalizeKey } from 'llm-dedup';

const dedup = createDedup();

async function chat(params: Record<string, unknown>) {
  const key = canonicalizeKey(params);

  // Check cache first
  const cached = await cache.get(key);
  if (cached) return cached;

  // Dedup concurrent cache misses
  const result = await dedup.execute(key, () =>
    openai.chat.completions.create(params)
  );

  // Store in cache for future sequential duplicates
  await cache.set(key, result);
  return result;
}
```

### Monitoring coalescing effectiveness

Use `stats()` to track how well dedup is performing:

```typescript
setInterval(() => {
  const s = dedup.stats();
  console.log(
    `Dedup: ${s.total} total, ${s.unique} unique, ${s.coalesced} coalesced ` +
    `(${(s.coalescedRate * 100).toFixed(1)}%), ${s.currentInflight} in-flight, ` +
    `peak ${s.peakInflight}`
  );
}, 60000);
```

### Inspecting in-flight entries

Use `getInflight()` to see what is currently being deduplicated:

```typescript
const inflight = dedup.getInflight();
for (const entry of inflight) {
  console.log(
    `Key: ${entry.key}, subscribers: ${entry.subscriberCount}, ` +
    `elapsed: ${entry.elapsedMs}ms`
  );
}
```

### Per-call timeout override

Override the instance-level timeout for a specific call:

```typescript
const result = await dedup.execute(key, fn, { maxWaitMs: 5000 });
```

### Graceful shutdown

Always call `close()` when shutting down to stop background timers and reject pending subscribers:

```typescript
process.on('SIGTERM', async () => {
  await dedup.close();
  process.exit(0);
});
```

### Using with Anthropic

The same pattern works with any LLM provider. `canonicalizeKey` recognizes Anthropic's `system` field:

```typescript
import { createDedup, canonicalizeKey } from 'llm-dedup';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const dedup = createDedup();

async function chat(params: Anthropic.MessageCreateParams) {
  const key = canonicalizeKey(params);
  return dedup.execute(key, () => client.messages.create(params));
}
```

---

## TypeScript

`llm-dedup` is written in TypeScript and ships type declarations (`dist/index.d.ts`). All public interfaces and error classes are exported:

```typescript
import {
  createDedup,
  canonicalizeKey,
  sortedStringify,
  hashString,
  DedupTimeoutError,
  DedupCancelError,
} from 'llm-dedup';

import type {
  LLMDedupOptions,
  LLMDedup,
  ExecuteOptions,
  InflightInfo,
  DedupStats,
} from 'llm-dedup';
```

The `execute` method is generic. The return type is inferred from the `fn` parameter:

```typescript
// result is inferred as OpenAI.ChatCompletion
const result = await dedup.execute(key, () =>
  openai.chat.completions.create(params)
);
```

---

## License

MIT
