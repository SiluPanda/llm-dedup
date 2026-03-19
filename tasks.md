# llm-dedup — Task Breakdown

All tasks derived from SPEC.md. Each task is granular and actionable. Status values: `not_done`, `in_progress`, `done`.

---

## Phase 1: Project Setup and Scaffolding

- [ ] **Install dev dependencies** — Add `typescript`, `vitest`, and `eslint` as devDependencies in `package.json`. Verify `npm install` succeeds cleanly. | Status: not_done
- [ ] **Configure Vitest** — Add a `vitest.config.ts` (or inline config in `package.json`) so that `npm run test` discovers and runs `src/__tests__/*.test.ts` files. | Status: not_done
- [ ] **Configure ESLint** — Add an `.eslintrc` or `eslint.config.js` for TypeScript linting. Ensure `npm run lint` runs without errors on the empty project. | Status: not_done
- [ ] **Verify build pipeline** — Run `npm run build` and confirm `tsc` compiles `src/index.ts` into `dist/index.js` and `dist/index.d.ts` with zero errors. | Status: not_done
- [ ] **Create file structure skeleton** — Create all source files listed in the spec's file structure (Section 18): `src/dedup.ts`, `src/registry.ts`, `src/identity.ts`, `src/normalize.ts`, `src/clone.ts`, `src/stream.ts`, `src/stats.ts`, `src/errors.ts`, `src/types.ts`, `src/wrapper/wrap.ts`, `src/wrapper/openai.ts`, `src/wrapper/anthropic.ts`. Each file starts with a module comment and an empty export. | Status: not_done
- [ ] **Create test file skeleton** — Create all test files: `src/__tests__/dedup.test.ts`, `registry.test.ts`, `identity.test.ts`, `normalize.test.ts`, `clone.test.ts`, `stream.test.ts`, `wrapper.test.ts`, `stats.test.ts`, `concurrency.test.ts`, `timeout.test.ts`, `edge-cases.test.ts`. Each file imports `describe`/`it`/`expect` from vitest with a placeholder test. | Status: not_done

---

## Phase 2: Types and Error Classes

- [ ] **Define LLMDedupOptions interface** — In `src/types.ts`, define the `LLMDedupOptions` interface with all configuration fields: `identityMode`, `keyFn`, `embedder`, `semanticThreshold`, `maxWaitMs`, `timeoutBehavior`, `maxSubscribers`, `streamDedup`, `abandonTimeoutMs`, `abandonSweepIntervalMs`, `modelPrices`, `tokenEstimator`, `normalizer`, `logger`. Include JSDoc comments for each field with its default value. | Status: not_done
- [ ] **Define InflightEntry interface** — In `src/types.ts`, define the internal `InflightEntry<T>` interface with fields: `key`, `ownerPromise`, `subscribers` (array of `{ resolve, reject, subscribedAt, timeoutTimer? }`), `createdAt`, `settled`, `embedding?`, `streaming?`, `streamBuffer?`. | Status: not_done
- [ ] **Define InflightInfo interface** — In `src/types.ts`, define the public `InflightInfo` interface returned by `getInflight()`: `key`, `subscriberCount`, `elapsedMs`, `createdAt`, `streaming`. | Status: not_done
- [ ] **Define DedupStats interface** — In `src/types.ts`, define `DedupStats` with fields: `total`, `unique`, `coalesced`, `coalescedRate`, `timeouts`, `errors`, `tokensSaved`, `costSaved`, `currentInflight`, `peakInflight`. | Status: not_done
- [ ] **Define ExecuteOptions interface** — In `src/types.ts`, define `ExecuteOptions` with `signal?: AbortSignal` and `maxWaitMs?: number`. | Status: not_done
- [ ] **Define WrapOptions interface** — In `src/types.ts`, define `WrapOptions` with fields: `identityMode`, `keyFn`, `embedder`, `semanticThreshold`, `clientType`, `extractParams`. | Status: not_done
- [ ] **Define LLMDedup interface** — In `src/types.ts`, define the public `LLMDedup` interface with method signatures: `execute<T>(key, fn, options?)`, `wrap<T>(client, options?)`, `getInflight()`, `stats()`, `resetStats()`, `cancelInflight(key)`, `cancelAll()`, `close()`. | Status: not_done
- [ ] **Implement DedupTimeoutError** — In `src/errors.ts`, implement `DedupTimeoutError extends Error` with readonly fields `code = 'DEDUP_TIMEOUT'`, `key: string`, `waitedMs: number`. Constructor accepts `key` and `waitedMs`. | Status: not_done
- [ ] **Implement DedupAbandonError** — In `src/errors.ts`, implement `DedupAbandonError extends Error` with readonly fields `code = 'DEDUP_ABANDON'`, `key: string`, `ageMs: number`. | Status: not_done
- [ ] **Implement DedupCancelError** — In `src/errors.ts`, implement `DedupCancelError extends Error` with readonly fields `code = 'DEDUP_CANCEL'`, `key: string`. | Status: not_done
- [ ] **Export all types and errors from index.ts** — Update `src/index.ts` to re-export all public types (`LLMDedupOptions`, `DedupStats`, `InflightInfo`, `ExecuteOptions`, `WrapOptions`, `LLMDedup`) and all error classes. | Status: not_done

---

## Phase 3: Request Parameter Normalization and Identity (Exact Mode)

- [ ] **Implement request parameter canonicalization** — In `src/normalize.ts`, implement a `canonicalize(params)` function that extracts output-affecting parameters (messages, model, temperature, top_p, max_tokens, frequency_penalty, presence_penalty, seed, tools, tool_choice, response_format, stop, logit_bias), excludes non-affecting parameters (stream, stream_options, n, user, api_key, timeout, request_id, organization), normalizes message content (Unicode NFC, trim whitespace), lowercases the model identifier, normalizes numeric parameters, and serializes with sorted keys at every nesting level. | Status: not_done
- [ ] **Implement deep sorted-key JSON serialization** — In `src/normalize.ts`, implement a `sortedStringify(value)` helper that recursively sorts object keys before stringifying, ensuring deterministic output regardless of insertion order. | Status: not_done
- [ ] **Implement Unicode NFC normalization** — In `src/normalize.ts`, ensure all string values in messages are normalized to NFC form using `String.prototype.normalize('NFC')`. | Status: not_done
- [ ] **Implement whitespace normalization** — In `src/normalize.ts`, trim leading/trailing whitespace from message content strings. | Status: not_done
- [ ] **Implement exact-match identity computation** — In `src/identity.ts`, implement `computeExactKey(params)` that calls `canonicalize(params)`, then computes `SHA-256` of the serialized string using `node:crypto`, returning a lowercase hex string. | Status: not_done
- [ ] **Support optional normalizer in identity computation** — In `src/identity.ts`, if a `normalizer` function is provided in options, apply it to the prompt text before canonicalization to increase match rates (e.g., extra whitespace collapsing). | Status: not_done
- [ ] **Write normalize unit tests** — In `src/__tests__/normalize.test.ts`, test: identical params produce same canonical form; differing output-affecting params produce different forms; `stream`, `user`, `api_key` are excluded; key order independence; Unicode NFC normalization; whitespace trimming; nested object key sorting. | Status: not_done
- [ ] **Write identity (exact) unit tests** — In `src/__tests__/identity.test.ts`, test: identical params produce same SHA-256 key; different params produce different keys; key is deterministic across calls; key is a 64-character lowercase hex string; normalizer integration changes key. | Status: not_done

---

## Phase 4: Response and Error Cloning

- [ ] **Implement response cloning** — In `src/clone.ts`, implement `cloneResponse<T>(response: T): T` using `structuredClone()`. This is the primary cloning mechanism for distributing the owner's response to subscribers. | Status: not_done
- [ ] **Implement error cloning** — In `src/clone.ts`, implement `cloneError(error: unknown): unknown` that clones an error preserving `message`, `name`, `stack`, `status`, `code`, and any custom properties set by LLM SDKs (e.g., OpenAI's `error.type`, `error.param`). Use `structuredClone` where possible, with manual property copying as fallback for non-cloneable error subclasses. | Status: not_done
- [ ] **Write clone unit tests** — In `src/__tests__/clone.test.ts`, test: cloned response is deep-equal but not reference-equal; mutating clone does not affect original; cloned error preserves `message`, `name`, `stack`, `status`, `code`, and custom properties; error clone is independent of original; handles `undefined` and `null` responses. | Status: not_done

---

## Phase 5: In-Flight Registry

- [ ] **Implement InflightRegistry class** — In `src/registry.ts`, implement a class wrapping `Map<string, InflightEntry>` with methods: `register(key, entry)`, `has(key)`, `get(key)`, `subscribe(key, subscriber)`, `settle(key, result)`, `settleError(key, error)`, `remove(key)`, `size`, `entries()`, `clear()`. | Status: not_done
- [ ] **Implement atomic check-and-register** — In `src/registry.ts`, ensure the `has()` check and `register()` call are synchronous (no `await` between them) to prevent race conditions in exact-match mode. | Status: not_done
- [ ] **Implement entry settlement** — In `src/registry.ts`, when `settle(key, result)` is called: set the entry's `settled` flag to true, iterate over all subscribers calling each `resolve` with a `structuredClone` of the result, clear all timeout timers, then remove the entry from the map. | Status: not_done
- [ ] **Implement error settlement** — In `src/registry.ts`, when `settleError(key, error)` is called: set `settled` flag, iterate subscribers calling each `reject` with a cloned error, clear timers, remove entry. | Status: not_done
- [ ] **Implement subscriber removal** — In `src/registry.ts`, implement `removeSubscriber(key, subscriber)` to detach a single subscriber (for timeout or abort). If no subscribers remain, the entry still persists until the owner settles. | Status: not_done
- [ ] **Prevent subscribing to settled entries** — In `src/registry.ts`, the `subscribe()` method must check `entry.settled` before adding the subscriber. If the entry is already settled, return `false` so the caller can register as a new owner instead. | Status: not_done
- [ ] **Write registry unit tests** — In `src/__tests__/registry.test.ts`, test: `register` adds entry; `has` returns true for registered keys and false for unregistered; `get` returns the entry; `subscribe` adds to subscriber list; `settle` calls all subscriber resolves with clones; `settleError` calls all subscriber rejects; `remove` deletes entry; `has` returns false after removal; subscribing to settled entry returns false; `clear` removes all entries. | Status: not_done

---

## Phase 6: Core Dedup Logic (createDedup + execute)

- [ ] **Implement createDedup factory** — In `src/dedup.ts`, implement `createDedup(options?: LLMDedupOptions): LLMDedup` that validates options, applies defaults (identityMode='exact', maxWaitMs=30000, maxSubscribers=100, streamDedup=true, abandonTimeoutMs=120000, abandonSweepIntervalMs=60000, timeoutBehavior='reject'), creates an `InflightRegistry`, initializes stats counters, and returns an `LLMDedup` instance. | Status: not_done
- [ ] **Implement dedup.execute()** — In `src/dedup.ts`, implement the `execute<T>(key: string, fn: () => Promise<T>, options?: ExecuteOptions): Promise<T>` method. Check registry for existing entry with the given key. If found and not settled, subscribe (return subscriber promise). If not found, register as owner, call `fn()`, on resolve settle all subscribers with cloned responses, on reject settle all subscribers with cloned errors, remove entry. Increment stats counters appropriately. | Status: not_done
- [ ] **Implement owner promise handling** — In `src/dedup.ts`, when the owner's `fn()` resolves: owner receives the original response, each subscriber receives `structuredClone(response)`, entry is removed. When `fn()` rejects: owner receives the original error (re-thrown), each subscriber receives `cloneError(error)`, entry is removed. | Status: not_done
- [ ] **Handle fn throwing synchronously** — In `src/dedup.ts`, wrap the `fn()` call in a try-catch to handle both synchronous throws and rejected promises. Both cases should propagate to subscribers identically. | Status: not_done
- [ ] **Handle fn returning a non-Promise** — In `src/dedup.ts`, if `fn()` returns a non-Promise value, wrap it with `Promise.resolve()` so the settlement flow works uniformly. | Status: not_done
- [ ] **Implement dedup.getInflight()** — In `src/dedup.ts`, return an array of `InflightInfo` objects from the registry, computing `elapsedMs` as `Date.now() - entry.createdAt`. | Status: not_done
- [ ] **Implement dedup.stats()** — In `src/dedup.ts`, return a `DedupStats` object with current counter values. `coalescedRate` is computed as `coalesced / total` (or 0 if total is 0). `currentInflight` is the registry size. | Status: not_done
- [ ] **Implement dedup.resetStats()** — In `src/dedup.ts`, reset all cumulative counters (total, unique, coalesced, timeouts, errors, tokensSaved, costSaved, peakInflight) to zero. | Status: not_done
- [ ] **Track peakInflight** — In `src/dedup.ts`, after each new owner registration, compare registry size to `peakInflight` and update if greater. | Status: not_done
- [ ] **Export createDedup from index.ts** — Update `src/index.ts` to export the `createDedup` factory as the primary public API entry point. | Status: not_done
- [ ] **Write core dedup unit tests** — In `src/__tests__/dedup.test.ts`, test: createDedup returns an LLMDedup instance; execute with unique key calls fn and returns result; execute with same key while in-flight subscribes and returns same result; owner error propagates to subscribers; stats reflect correct counts; getInflight returns current entries; resetStats clears counters. | Status: not_done
- [ ] **Write concurrency tests** — In `src/__tests__/concurrency.test.ts`, test: N concurrent calls with same key result in fn called once and all N receive same response (deep-equal, not reference-equal); N calls with K different keys result in fn called K times; rapid sequential calls before first settles are coalesced; settlement notifies all subscribers. | Status: not_done

---

## Phase 7: Timeout, Cancellation, and Lifecycle

- [ ] **Implement subscriber timeout (reject mode)** — In `src/dedup.ts`, when a subscriber is registered, start a timer `setTimeout(detach, maxWaitMs)`. If the timer fires before the owner settles, remove the subscriber from the entry and reject the subscriber's promise with `DedupTimeoutError`. Clear the timer when the owner settles. Increment `stats.timeouts`. | Status: not_done
- [ ] **Implement subscriber timeout (fallthrough mode)** — In `src/dedup.ts`, when `timeoutBehavior: 'fallthrough'` is configured, on timeout: detach the subscriber from the entry, then execute the subscriber's own `fn()` independently and resolve the subscriber's promise with the result of that independent call. | Status: not_done
- [ ] **Support per-call maxWaitMs override** — In `src/dedup.ts`, `ExecuteOptions.maxWaitMs` overrides the instance-level `maxWaitMs` for a single `execute()` call. | Status: not_done
- [ ] **Implement AbortSignal support** — In `src/dedup.ts`, when `ExecuteOptions.signal` is provided, listen for the `abort` event. On abort: remove the subscriber from the entry, reject the subscriber's promise with an `AbortError`, clear the timeout timer. If the caller is the owner, the owner's fn continues running but the result is discarded for that caller. | Status: not_done
- [ ] **Implement maxSubscribers enforcement** — In `src/dedup.ts`, before subscribing to an in-flight entry, check if `entry.subscribers.length >= maxSubscribers`. If so, bypass dedup: register the new request as an independent owner with a suffixed key, log a warning via `logger.warn`. Record as `unique` in stats, not `coalesced`. | Status: not_done
- [ ] **Implement dedup.cancelInflight(key)** — In `src/dedup.ts`, remove the entry for the given key, reject all subscribers with `DedupCancelError`. The owner's fn continues running but its result is discarded. | Status: not_done
- [ ] **Implement dedup.cancelAll()** — In `src/dedup.ts`, iterate all entries, reject all subscribers with `DedupCancelError`, clear the registry. | Status: not_done
- [ ] **Implement abandon sweep** — In `src/dedup.ts` or `src/registry.ts`, start a `setInterval` with period `abandonSweepIntervalMs`. On each tick, iterate all entries and remove any whose age (`Date.now() - createdAt`) exceeds `abandonTimeoutMs`. Reject all subscribers of abandoned entries with `DedupAbandonError`. Log a warning. | Status: not_done
- [ ] **Implement dedup.close()** — In `src/dedup.ts`, clear the abandon sweep interval timer, call `cancelAll()` to reject all pending subscribers, and mark the instance as closed (subsequent `execute` calls should throw). | Status: not_done
- [ ] **Write timeout tests** — In `src/__tests__/timeout.test.ts`, test: subscriber rejects with DedupTimeoutError after maxWaitMs; fallthrough mode sends independent request on timeout; per-call maxWaitMs override works; owner continues unaffected after subscriber timeout; timer is cleared on normal settlement. | Status: not_done
- [ ] **Write cancellation and abort tests** — In `src/__tests__/timeout.test.ts` (or separate file), test: cancelInflight rejects subscribers with DedupCancelError; cancelAll rejects all subscribers; AbortSignal removes subscriber and rejects with AbortError; owner is unaffected by subscriber abort. | Status: not_done
- [ ] **Write abandon sweep tests** — In `src/__tests__/timeout.test.ts`, test: entries older than abandonTimeoutMs are removed by sweep; subscribers of abandoned entries receive DedupAbandonError; sweep interval is configurable; close() stops the sweep timer. | Status: not_done

---

## Phase 8: Cost Tracking and Statistics

- [ ] **Implement default token estimator** — In `src/stats.ts`, implement the default token estimation function: `(text: string) => Math.ceil(text.length / 4)`. | Status: not_done
- [ ] **Implement built-in model prices** — In `src/stats.ts`, define a `DEFAULT_MODEL_PRICES` map with prices ($/MTok) for: `gpt-4o` (2.50/10.00), `gpt-4o-mini` (0.15/0.60), `gpt-4-turbo` (10.00/30.00), `gpt-3.5-turbo` (0.50/1.50), `claude-sonnet-4-20250514` (3.00/15.00), `claude-3-5-sonnet-20241022` (3.00/15.00), `claude-3-haiku-20240307` (0.25/1.25). Fallback: `{ input: 1.00, output: 2.00 }`. | Status: not_done
- [ ] **Implement per-coalesced-request cost computation** — In `src/stats.ts`, implement `computeCostSaved(model, promptText, responseText, modelPrices, tokenEstimator)` that estimates input/output tokens using the token estimator, looks up the model price (user-provided > built-in > fallback), and returns `{ tokensSaved, costSaved }`. Cost formula: `(inputTokens / 1_000_000 * inputPrice) + (outputTokens / 1_000_000 * outputPrice)`. | Status: not_done
- [ ] **Integrate cost tracking into dedup settlement** — In `src/dedup.ts`, after the owner's request resolves successfully, compute cost savings for each coalesced subscriber and add to cumulative `stats.tokensSaved` and `stats.costSaved`. Extract model and text from the request params and response. | Status: not_done
- [ ] **Support user-provided modelPrices** — In `src/dedup.ts`, merge user-provided `modelPrices` with built-in defaults, giving user prices precedence. | Status: not_done
- [ ] **Support user-provided tokenEstimator** — In `src/dedup.ts`, allow users to provide a custom `tokenEstimator` function that overrides the default `text.length / 4`. | Status: not_done
- [ ] **Write stats unit tests** — In `src/__tests__/stats.test.ts`, test: default token estimator returns `ceil(text.length / 4)`; cost computation with known token counts and model prices; built-in model prices are correct; fallback price used for unknown models; user-provided prices override built-in; cumulative stats accumulate correctly; resetStats zeroes all counters. | Status: not_done

---

## Phase 9: Client Wrapper (Proxy-based)

- [ ] **Implement OpenAI parameter extractor** — In `src/wrapper/openai.ts`, implement a function that extracts LLM request parameters from OpenAI's `chat.completions.create()` call arguments: `messages`, `model`, `temperature`, `top_p`, `max_tokens`, `tools`, `tool_choice`, `response_format`, `stream`, etc. | Status: not_done
- [ ] **Implement Anthropic parameter extractor** — In `src/wrapper/anthropic.ts`, implement a function that extracts LLM request parameters from Anthropic's `messages.create()` call arguments. | Status: not_done
- [ ] **Implement client auto-detection** — In `src/wrapper/wrap.ts`, implement logic to detect whether a client is OpenAI-style (has `client.chat.completions.create`) or Anthropic-style (has `client.messages.create`) by inspecting the object shape. | Status: not_done
- [ ] **Implement dedup.wrap()** — In `src/wrapper/wrap.ts`, implement `wrap<T>(client: T, options?: WrapOptions): T` that returns a JavaScript `Proxy` intercepting the appropriate method calls (`chat.completions.create` for OpenAI, `messages.create` for Anthropic). The proxy computes the identity key from extracted parameters, calls `dedup.execute(key, () => originalMethod(...args))`, and returns the result. | Status: not_done
- [ ] **Support custom parameter extractor in wrap** — In `src/wrapper/wrap.ts`, if `WrapOptions.extractParams` is provided, use it instead of the built-in OpenAI/Anthropic extractors, enabling support for custom or unknown client types. | Status: not_done
- [ ] **Handle stream parameter in wrap** — In `src/wrapper/wrap.ts`, when intercepting a call: exclude `stream` from identity key computation (so streaming and non-streaming requests for the same prompt coalesce). If `streamDedup: false` and the request has `stream: true`, bypass the dedup layer entirely. | Status: not_done
- [ ] **Write wrapper unit tests** — In `src/__tests__/wrapper.test.ts`, test: wrap returns a proxy that behaves like the original client; concurrent identical calls through wrapped client result in one fn execution; different calls result in separate fn executions; OpenAI parameter extraction is correct; Anthropic parameter extraction is correct; client auto-detection works; custom extractParams is used; stream parameter is excluded from key; streamDedup=false bypasses dedup for streaming calls. | Status: not_done

---

## Phase 10: Streaming Dedup

- [ ] **Implement stream buffer** — In `src/stream.ts`, implement a `StreamBuffer` class that accepts an async iterable (the owner's stream), buffers each chunk as it arrives, forwards chunks to the owner in real time, and maintains the buffer for replay to subscribers. | Status: not_done
- [ ] **Implement subscriber stream creation** — In `src/stream.ts`, implement `createSubscriberStream(buffer)` that returns an async iterable. The iterable first yields all buffered chunks (replay), then yields future chunks as they arrive from the owner's stream, and completes when the owner's stream completes. | Status: not_done
- [ ] **Implement late subscriber handling** — In `src/stream.ts`, when a subscriber joins after the owner's stream has already completed, return an async iterable that replays all buffered chunks immediately and then completes. | Status: not_done
- [ ] **Implement mid-stream subscriber handling** — In `src/stream.ts`, when a subscriber joins while the owner's stream is in progress, replay all buffered chunks rapidly, then transition to real-time forwarding of subsequent chunks. | Status: not_done
- [ ] **Handle streaming owner with non-streaming subscriber** — In `src/stream.ts` or `src/dedup.ts`, when the owner is streaming but the subscriber requested a non-streaming response, buffer the entire stream, assemble the full response, and resolve the subscriber's promise with the assembled response object. | Status: not_done
- [ ] **Handle non-streaming owner with streaming subscriber** — In `src/stream.ts` or `src/dedup.ts`, when the owner is non-streaming but the subscriber requested a streaming response, wrap the complete response as a synthetic single-chunk stream and deliver it to the subscriber. | Status: not_done
- [ ] **Handle stream errors** — In `src/stream.ts`, if the owner's stream emits an error mid-stream, propagate the error to all subscribers (both those currently iterating and those that will subscribe later). | Status: not_done
- [ ] **Implement streamDedup: false bypass** — In `src/dedup.ts`, when `streamDedup` is set to false, detect streaming requests (by checking the `stream` parameter) and skip the dedup layer entirely, passing them straight to the LLM. | Status: not_done
- [ ] **Integrate streaming into execute/wrap** — In `src/dedup.ts`, detect whether `fn` returns an async iterable (streaming) or a plain promise (non-streaming). For streaming, use the `StreamBuffer` for owner and `createSubscriberStream` for subscribers. | Status: not_done
- [ ] **Write streaming unit tests** — In `src/__tests__/stream.test.ts`, test: streaming owner with streaming subscriber receives all chunks in order; late subscriber receives full replay; mid-stream subscriber receives buffered then real-time chunks; streaming owner with non-streaming subscriber receives assembled response; non-streaming owner with streaming subscriber receives synthetic stream; stream error propagates to all subscribers; streamDedup=false bypasses dedup for streams; buffer memory is released after settlement. | Status: not_done

---

## Phase 11: Semantic Identity Mode

- [ ] **Implement cosine similarity computation** — In `src/identity.ts`, implement `cosineSimilarity(a: number[], b: number[]): number` that computes the cosine similarity between two embedding vectors. | Status: not_done
- [ ] **Implement semantic key matching** — In `src/identity.ts`, implement `findSimilarInflight(embedding, registry, threshold)` that iterates over all in-flight entries, computes cosine similarity between the given embedding and each entry's stored embedding, and returns the key of the first entry exceeding the threshold (or `null` if none). | Status: not_done
- [ ] **Implement semantic identity mode in execute** — In `src/dedup.ts`, when `identityMode: 'semantic'`, compute the embedding via the caller-provided `embedder(promptText)`, then use `findSimilarInflight` to check for a match. If a match is found, subscribe. If not, register a new entry with the computed embedding stored on the entry. | Status: not_done
- [ ] **Extract prompt text for embedding** — In `src/identity.ts`, implement `extractPromptText(params)` that extracts the concatenated user message content from request parameters for embedding computation. | Status: not_done
- [ ] **Validate semantic mode configuration** — In `src/dedup.ts`, when `identityMode: 'semantic'` is set, validate that `embedder` is provided. Throw a descriptive error if missing. Apply default `semanticThreshold: 0.95`. | Status: not_done
- [ ] **Implement custom identity mode** — In `src/dedup.ts`, when `identityMode: 'custom'`, validate that `keyFn` is provided. Use `keyFn(params)` to compute the identity key directly (no hashing). | Status: not_done
- [ ] **Write semantic identity tests** — In `src/__tests__/identity.test.ts`, test: cosine similarity of identical vectors is 1.0; cosine similarity of orthogonal vectors is 0.0; similar embeddings above threshold produce a match; dissimilar embeddings below threshold do not match; threshold boundary behavior (exactly at threshold); semantic mode with embedder function coalesces similar requests; custom keyFn is used correctly. | Status: not_done

---

## Phase 12: Edge Case Handling

- [ ] **Handle undefined/null response from fn** — In `src/dedup.ts`, ensure that if the owner's `fn` resolves with `undefined` or `null`, subscribers receive `undefined`/`null` without error. `structuredClone(null)` returns `null`; `structuredClone(undefined)` returns `undefined`. | Status: not_done
- [ ] **Handle concurrent settle and subscribe race** — In `src/registry.ts`, ensure the `settled` flag is checked before adding a subscriber. If the entry is already settled at the moment of subscription, treat as no match and register as a new owner. | Status: not_done
- [ ] **Handle zero concurrent overlap** — Ensure dedup is a clean pass-through when all requests have unique keys: no coalescing, minimal overhead, stats show 0 coalesced. | Status: not_done
- [ ] **Handle 100% concurrent overlap** — Ensure that when all N requests share the same key, fn is called exactly once, N-1 are coalesced, and all N receive the same response. | Status: not_done
- [ ] **Handle very large subscriber count** — Test that 1000 subscribers on a single entry all receive the response without excessive memory usage or event loop blocking. | Status: not_done
- [ ] **Handle empty registry queries** — Ensure `getInflight()` returns an empty array and `stats()` returns all zeros when no requests have been processed. | Status: not_done
- [ ] **Handle single request (no concurrency)** — Ensure a single request becomes the owner, executes normally, and stats show 1 unique / 0 coalesced. | Status: not_done
- [ ] **Handle execute after close** — Ensure that calling `execute()` after `close()` throws a descriptive error. | Status: not_done
- [ ] **Write edge case tests** — In `src/__tests__/edge-cases.test.ts`, test all the above edge cases plus: fn returns non-Promise value; fn throws synchronously; empty messages array; very large request parameters; concurrent calls with overlapping and non-overlapping keys. | Status: not_done

---

## Phase 13: Integration Tests

- [ ] **End-to-end with mock LLM client** — In `src/__tests__/dedup.test.ts` or a dedicated integration test file, create a mock LLM client object with a `chat.completions.create` method. Wrap it with `dedup.wrap()`. Send concurrent identical requests. Assert the mock was called once, and all callers received the correct response. | Status: not_done
- [ ] **End-to-end with execute API** — Test `dedup.execute()` with a mock async function. Launch multiple concurrent calls with the same key. Assert fn is called once. Assert all callers receive deep-equal but reference-distinct results. | Status: not_done
- [ ] **AbortSignal integration test** — Test that aborting a subscriber via AbortController does not affect the owner or other subscribers. Verify the aborted subscriber's promise rejects with AbortError. | Status: not_done
- [ ] **Process shutdown test** — Test that `dedup.close()` cleans up the sweep interval timer and rejects all pending subscribers with DedupCancelError. Verify no timers are leaked (no process hang). | Status: not_done
- [ ] **Layering with mock cache test** — Create a mock cache layer. Layer dedup on top. Verify that concurrent cache misses for the same prompt result in a single fn execution (dedup handles concurrency) and that subsequent calls hit the cache. | Status: not_done

---

## Phase 14: Performance Tests

- [ ] **Benchmark identity computation** — Write a performance test that benchmarks SHA-256 key computation for requests of various sizes (1KB, 5KB, 10KB). Assert under 100 microseconds for a 10KB request. | Status: not_done
- [ ] **Benchmark registry lookup** — Write a performance test that benchmarks `Map.has()` + `Map.get()` for registries with 10, 100, 1000 entries. Assert under 1 microsecond per lookup. | Status: not_done
- [ ] **Benchmark structuredClone overhead** — Write a performance test that benchmarks `structuredClone` for response objects of various sizes (1KB, 5KB, 20KB). Assert under 0.5ms for 20KB. | Status: not_done
- [ ] **Benchmark total dedup hit overhead** — Write an end-to-end performance test measuring the full pipeline (identity computation + registry check + subscription) for a dedup hit. Assert under 0.5ms total. | Status: not_done
- [ ] **Benchmark throughput with dedup vs without** — Measure requests/second with dedup enabled vs. a baseline passthrough. Assert dedup overhead is under 1% of total request time for typical LLM latencies. | Status: not_done

---

## Phase 15: Documentation

- [ ] **Write README.md** — Create `README.md` with: package description, installation instructions, quick-start example (createDedup + execute), quick-start example (wrap), API reference for all public methods and options, streaming dedup explanation, cost tracking explanation, integration examples (with llm-response-cache, llm-retry, prompt-dedup), configuration reference table, architecture diagram (request flow), performance characteristics, and license. | Status: not_done
- [ ] **Add JSDoc comments to all public APIs** — Ensure `createDedup`, `execute`, `wrap`, `getInflight`, `stats`, `resetStats`, `cancelInflight`, `cancelAll`, `close`, and all option interfaces have comprehensive JSDoc comments. | Status: not_done
- [ ] **Add inline code comments** — Add explanatory comments in complex sections: the atomic check-and-register in the registry, the stream buffer-and-replay mechanism, the settlement fan-out loop, and the semantic identity matching. | Status: not_done

---

## Phase 16: CI/CD and Publishing Preparation

- [ ] **Verify npm run test passes** — Run the full test suite (`vitest run`) and confirm all tests pass with zero failures. | Status: not_done
- [ ] **Verify npm run lint passes** — Run ESLint on `src/` and confirm zero errors and zero warnings. | Status: not_done
- [ ] **Verify npm run build passes** — Run `tsc` and confirm zero compile errors. Verify `dist/` contains `index.js`, `index.d.ts`, and all module files with source maps and declaration maps. | Status: not_done
- [ ] **Verify package.json metadata** — Ensure `name`, `version`, `description`, `main`, `types`, `files`, `engines`, `license`, `keywords`, and `publishConfig` are correct. Add relevant keywords (e.g., `llm`, `dedup`, `deduplication`, `coalesce`, `singleflight`, `in-flight`, `request-coalescing`). | Status: not_done
- [ ] **Bump version in package.json** — Set version to `1.0.0` (or appropriate semver) for initial release once all features are implemented. | Status: not_done
- [ ] **Verify prepublishOnly hook** — Confirm that `npm publish` triggers `npm run build` via the `prepublishOnly` script. | Status: not_done
