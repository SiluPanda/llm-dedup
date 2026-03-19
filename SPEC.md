# llm-dedup -- Specification

## 1. Overview

`llm-dedup` is an in-flight request coalescing layer for LLM APIs that prevents duplicate concurrent requests by sharing a single LLM call's result across all callers that send matching requests while the first is still processing. It accepts an LLM request, computes a request identity (hash or embedding), checks an in-flight registry for a matching pending request, and either subscribes the caller to the existing in-flight request's Promise or registers a new in-flight request and sends it to the LLM. When the LLM responds, all subscribers receive the same response. When the LLM errors, all subscribers receive the same error. The in-flight entry is removed from the registry immediately after resolution.

The gap this package fills is specific and well-defined. LLM response caches (`llm-response-cache`, `llm-semantic-cache`) solve the problem of repeated requests _over time_: a request that was answered five minutes ago can be served from cache without calling the LLM again. But caches only help _after_ the first response is stored. They cannot help with the thundering herd problem: when multiple callers send the same (or similar) request simultaneously, _before_ any response exists in the cache, every request goes to the LLM independently. If 10 users ask "What is the capital of France?" within the same second, and the LLM takes 2 seconds to respond, all 10 requests are dispatched to the LLM in parallel. The cache is empty when the first request arrives, still empty when the tenth request arrives (because the first has not yet responded), and all 10 cost money. After the first responds and is cached, subsequent requests are cache hits -- but the damage from the initial burst is already done.

This is the cache stampede problem (also called the thundering herd problem, dogpile effect, or cache storm) applied to LLM APIs. It is a well-known problem in web infrastructure -- CDNs solve it with request coalescing (Cloudflare calls it "request collapsing," Varnish calls it "grace mode"), Go solves it with `golang.org/x/sync/singleflight`, and some caching libraries solve it with "stampede protection" or "lock-and-wait" patterns. But no existing npm package applies this pattern specifically to LLM API calls with LLM-aware request identity, streaming response handling, cost-savings tracking, and integration with the LLM caching ecosystem.

`llm-dedup` solves this by maintaining an in-flight registry -- a `Map` of request identity keys to pending Promises. When a request arrives, its identity is computed (SHA-256 hash of normalized prompt + model + parameters, or optionally an embedding-based similarity check). If a matching entry exists in the registry, the caller receives a subscriber Promise that resolves when the original (owner) request resolves. If no match exists, the request is registered as the owner, dispatched to the LLM, and its Promise is stored in the registry. When the owner Promise settles (resolves or rejects), all subscriber Promises settle with the same value, and the registry entry is removed. The registry is entirely ephemeral -- entries exist only for the duration of an in-flight request (typically 1-30 seconds) and are never persisted.

This package provides a `createDedup(options?)` factory that returns an `LLMDedup` instance, a `dedup.execute(key, fn)` method for explicit coalescing of arbitrary async functions (like Go's `singleflight.Do`), a `dedup.wrap(client, options?)` method that returns a proxy LLM client where all chat/completion calls are transparently coalesced, and a `dedup.stats()` method that reports how many requests were coalesced and the estimated cost savings. It handles streaming responses by buffering the owner's stream and replaying it to subscribers, handles errors by propagating them to all subscribers, and handles timeouts by allowing subscribers to opt out and send their own request if the owner takes too long.

This package is distinct from `llm-response-cache`, which caches completed responses for future requests using exact hash matching. `llm-response-cache` is persistent (entries survive across requests and process restarts); `llm-dedup` is ephemeral (entries exist only while a request is in-flight). `llm-response-cache` handles sequential duplicates (same request minutes or hours apart); `llm-dedup` handles concurrent duplicates (same request within the same 1-30 second window). The two are complementary: layer `llm-dedup` on top of the cache so that concurrent misses on the same prompt result in a single LLM call.

This package is distinct from `llm-semantic-cache`, which uses embedding-based similarity to cache responses for semantically equivalent prompts. `llm-semantic-cache` requires embedding computation, vector storage, and a similarity threshold. `llm-dedup` defaults to exact hash matching for request identity, which is typically sufficient for in-flight deduplication because concurrent identical requests (same user clicking twice, multiple instances processing the same queue item, load balancer spraying the same request) are far more common than concurrent paraphrases. Semantic in-flight matching is supported as an optional mode for applications that need it, but the default is exact matching for speed and simplicity.

This package is distinct from generic deduplication libraries like `p-memoize` (which memoizes function calls but does not handle LLM-specific concerns like streaming, cost tracking, or request identity based on normalized LLM parameters) and `dataloader` (which batches multiple distinct requests into a single batch call, not deduplicating identical requests into a single call).

---

## 2. Goals and Non-Goals

### Goals

- Provide a `createDedup(options?)` factory that returns an `LLMDedup` instance configured with identity mode, dedup window, subscriber limits, streaming behavior, and cost tracking settings.
- Provide a `dedup.execute(key, fn)` method that coalesces concurrent calls with the same key. The first caller's `fn` is executed; subsequent callers with the same key receive the same Promise. When the Promise settles, the key is removed from the in-flight registry. This is the low-level primitive, analogous to Go's `singleflight.Do`.
- Provide a `dedup.wrap(client, options?)` method that returns a proxy LLM client where all chat/completion calls are transparently coalesced. The proxy computes request identity from normalized LLM parameters, checks the in-flight registry, and either subscribes to an existing in-flight request or dispatches a new one. Application code uses the wrapped client identically to the original client.
- Provide a `dedup.getInflight()` method that returns the current in-flight requests -- their keys, subscriber counts, elapsed time, and owner status. Useful for monitoring and debugging.
- Provide a `dedup.stats()` method returning `DedupStats` with total requests, coalesced count, unique count, coalesced percentage, estimated tokens saved, and estimated cost saved.
- Implement exact-match request identity as the default mode. Request identity is computed as `SHA-256(canonicalize(messages, model, temperature, top_p, max_tokens, tools, response_format, ...))` -- the same canonicalization used by `llm-response-cache`. Two requests with the same normalized parameters produce the same identity key. This mode has sub-microsecond overhead and zero external dependencies.
- Support semantic-match request identity as an optional mode. The caller provides an embedding function, and request identity is determined by cosine similarity between the new request's prompt embedding and the embeddings of all in-flight requests. If any in-flight request's embedding exceeds the similarity threshold, the new request subscribes to it. This mode adds embedding latency but catches paraphrased concurrent requests.
- Support custom identity functions via a `keyFn` option. The caller provides a function `(params) => string` that computes the identity key from request parameters. This enables domain-specific identity logic (e.g., ignoring certain parameters, grouping requests by category).
- Handle streaming responses by buffering the owner's stream chunks and replaying the buffered chunks to all subscribers. Subscribers receive a stream that replays all chunks that arrived before their subscription plus all future chunks as they arrive from the owner. Streaming dedup is enabled by default and can be disabled (in which case streaming requests bypass the dedup layer).
- Handle errors by propagating the owner's error to all subscribers. If the owner request fails, all subscriber Promises reject with a deep clone of the error. Subscribers do not retry independently by default -- they receive the error and the caller decides whether to retry.
- Handle timeouts via a configurable dedup window. If a subscriber has been waiting longer than `maxWaitMs`, it detaches from the in-flight request and sends its own request to the LLM. This prevents a slow owner from blocking all subscribers indefinitely.
- Track cost savings: each coalesced request avoids one LLM API call. The cost of each avoided call is estimated from the prompt token count and model pricing, using the same estimation approach as `llm-response-cache`.
- Provide deep cloning of responses delivered to subscribers to prevent mutation of shared objects. Each subscriber receives an independent copy of the response.
- Provide memory safety guarantees: in-flight registry entries are removed on settlement (resolve or reject), on timeout, and on explicit cancellation. Abandoned entries are cleaned up by a configurable sweep interval. The registry cannot grow unboundedly.
- Zero runtime dependencies for the core exact-match mode. Optional peer dependency on an embedding function for semantic mode.
- Target Node.js 18+. Use `node:crypto` for SHA-256 hashing, native `Promise` for concurrency, `structuredClone` for response cloning.

### Non-Goals

- **Not a cache.** This package does not store responses beyond the lifetime of the in-flight request. Once the owner request completes and all subscribers are notified, the response is discarded. For persistent caching of LLM responses, use `llm-response-cache` (exact match) or `llm-semantic-cache` (semantic match). `llm-dedup` is the ephemeral complement to persistent caching.
- **Not a request batcher.** This package does not combine multiple _different_ requests into a single batch API call. It coalesces multiple _identical_ (or similar) requests into a single request. For batching distinct requests into a single API call (e.g., OpenAI's batch API), use a dedicated batching library. `llm-dedup` reduces redundancy; batching reduces overhead.
- **Not a rate limiter or throttler.** This package does not limit the rate of requests to the LLM API. It reduces the number of requests by eliminating duplicates, which indirectly reduces rate limit pressure, but it does not enforce rate limits, queue excess requests, or implement backoff. For rate limiting, use `llm-rate-limiter` or a dedicated rate limiting library.
- **Not a retry layer.** When the owner request fails, subscribers receive the error. `llm-dedup` does not retry the failed request. For retry logic with exponential backoff, use `llm-retry`. The two are complementary: wrap the client with `llm-retry` first, then with `llm-dedup`, so retries happen at the individual-request level and dedup happens at the coalesced level.
- **Not an LLM provider or proxy.** This package intercepts LLM calls to check the in-flight registry but does not implement any LLM API. It does not route requests, load balance, or manage API keys.
- **Not a distributed coordinator.** The in-flight registry is process-local (an in-memory `Map`). It does not coordinate across multiple processes or machines. Two Node.js processes running `llm-dedup` independently will each maintain their own registry and may send duplicate requests for the same prompt. For cross-process dedup, place a shared cache (Redis-backed `llm-response-cache`) in front of the dedup layer so that cross-process duplicates are caught by the cache, and within-process duplicates are caught by the dedup layer.
- **Not an embedding provider.** When using semantic identity mode, this package does not generate embeddings itself. It wraps a caller-provided embedding function with the signature `(text: string) => Promise<number[]>`.

---

## 3. Target Users and Use Cases

### High-Concurrency Chatbot Operators

Teams operating shared chatbots where many users interact simultaneously. A company-wide Slack bot that answers HR questions receives bursts of identical queries -- when a policy change is announced, dozens of employees ask "What is the new PTO policy?" within seconds. Without dedup, each query is a separate LLM call. With `llm-dedup`, the first query goes to the LLM, and all subsequent identical queries within the response window receive the same answer. A chatbot handling 1,000 queries/hour during peak with 30% concurrent duplicates saves 300 LLM calls/hour. At $0.01 per call (GPT-4o, 500-token response), that is $3/hour or $72/day during peak periods.

### API Gateway Engineers

Teams building API gateways or BFF (backend-for-frontend) layers that proxy LLM requests from multiple frontend clients. When a product page loads, multiple frontend components may independently request the same LLM-generated content (product description, review summary, FAQ answers). Without dedup, each component's request generates a separate LLM call. With `llm-dedup` at the gateway layer, concurrent requests for the same content are coalesced. An API gateway handling 10,000 requests/minute with 15% concurrent overlap eliminates 1,500 redundant calls/minute.

### Batch Processing Pipeline Operators

Teams running batch processing pipelines where the same prompt appears multiple times in the input batch. A content moderation pipeline processes 50,000 user posts per hour, sending each to the LLM for classification. If 5% of posts are identical (common short posts like "hello", "thanks", "lol"), 2,500 redundant calls per hour are eliminated. More importantly, if the pipeline is parallelized across workers, multiple workers may pick up identical posts from the queue simultaneously -- the cache is empty because no worker has completed the classification yet, and all workers send separate requests. `llm-dedup` catches these concurrent duplicates that the cache misses.

### Cache Stampede Prevention

Teams using `llm-response-cache` or `llm-semantic-cache` that experience cache stampedes during cold starts or cache invalidation. When the cache is empty (first deployment, cache clear, model version invalidation), all incoming requests are cache misses. If 100 users send the same popular query in the first minute after a cold start, all 100 go to the LLM. With `llm-dedup` layered on top of the cache, the first miss triggers an LLM call, the remaining 99 subscribe to the in-flight request, and the response is cached on completion. The cold-start cost drops from 100x to 1x per unique prompt.

### Cost Optimization Engineers

Engineers tasked with reducing LLM API spend who have already deployed response caching and are looking for the next layer of savings. Caching eliminates sequential duplicates; dedup eliminates concurrent duplicates. The `dedup.stats()` method provides concrete metrics: "llm-dedup coalesced 12,400 requests into 3,100 unique calls, saving an estimated $186 in the last 24 hours." Combined with `llm-response-cache` stats, this gives a complete picture of redundancy elimination.

### Multi-Tenant SaaS Platforms

Platforms where multiple tenants generate similar or identical LLM requests. A SaaS platform offering AI-powered document analysis may receive the same template-generated prompt from different tenants processing similar documents. `llm-dedup` ensures that concurrent identical requests from different tenants share a single LLM call, with each tenant receiving an independent copy of the response.

### Real-Time Collaborative Applications

Applications where multiple users interact with the same LLM-powered feature simultaneously. A collaborative document editor that offers AI writing suggestions may receive identical suggestion requests when multiple users are editing the same section. A coding assistant integrated into a shared development environment may receive identical code completion requests from multiple developers working on the same file.

---

## 4. Core Concepts

### In-Flight Request

An in-flight request is an LLM API call that has been sent but has not yet received a response. The request is "in flight" from the moment it is dispatched to the LLM until the moment the response (or error) is received. The duration of an in-flight request is typically 500ms to 30 seconds, depending on the model, prompt complexity, response length, and API load.

`llm-dedup` tracks all in-flight requests in a registry. Each registry entry represents one active LLM API call and the set of callers waiting for its result. The registry is the central data structure of the dedup layer -- it is checked on every incoming request, updated when new requests are dispatched, and cleaned up when responses arrive.

### Request Identity

Request identity determines whether two requests are "the same" for deduplication purposes. Two requests with the same identity should produce the same LLM response, so it is safe to share one response across both callers.

Identity can be computed in three ways:

1. **Exact match (default):** The identity key is a SHA-256 hash of the canonicalized request parameters (messages, model, temperature, top_p, max_tokens, tools, response_format, etc.). Two requests match only if their normalized parameters are byte-identical. This is the same canonicalization used by `llm-response-cache`. Exact matching is fast (sub-microsecond hash computation), deterministic, and has zero false positives. It catches concurrent identical requests (same user double-clicking, queue workers processing the same item, load balancer retries) but does not catch concurrent paraphrases.

2. **Semantic match (optional):** The identity is determined by embedding the prompt and computing cosine similarity against the embeddings of all in-flight requests. If any in-flight request has similarity above a threshold, the new request subscribes to it. This catches concurrent paraphrases ("What's the capital of France?" and "Tell me France's capital") but adds embedding latency (1-500ms) and requires a caller-provided embedding function. Semantic matching is rarely needed for in-flight dedup because concurrent paraphrases (two users independently phrasing the same question differently within the same 2-second window) are far less common than concurrent identical requests.

3. **Custom key function:** The caller provides `keyFn: (params) => string` that computes the identity key from request parameters. This enables domain-specific identity logic, such as ignoring certain parameters, grouping requests by intent category, or using a pre-computed key.

### Request Coalescing

Request coalescing is the process of merging multiple identical in-flight requests into a single LLM API call. The term comes from CDN and proxy engineering, where multiple identical upstream requests are "coalesced" into a single request to the origin server, and the response is "fanned out" to all waiting clients.

In `llm-dedup`, coalescing works as follows:
- The first request with a given identity key becomes the **owner**. The owner's function is executed (the actual LLM API call is made), and the owner's Promise is stored in the registry.
- Subsequent requests with the same identity key become **subscribers**. They do not execute their function. Instead, they receive a derived Promise that settles when the owner's Promise settles.
- When the owner's Promise resolves, all subscribers receive a deep clone of the response.
- When the owner's Promise rejects, all subscribers receive a clone of the error.
- The registry entry is removed immediately after the owner's Promise settles.

### Promise Sharing

Promise sharing is the mechanism by which the owner's result is distributed to subscribers. The implementation does not literally share the same Promise object (which would prevent independent error handling and would allow one subscriber to interfere with another). Instead, each subscriber receives its own Promise that is resolved or rejected when the owner's Promise settles.

Internally, each in-flight registry entry maintains a list of `{ resolve, reject }` callback pairs -- one pair per subscriber. When the owner settles:
- On resolve: each subscriber's `resolve` is called with a deep clone of the response (`structuredClone`).
- On reject: each subscriber's `reject` is called with a clone of the error.

Deep cloning ensures that subscribers cannot mutate the shared response. If subscriber A modifies the response object (e.g., `response.choices[0].message.content = 'modified'`), subscriber B is unaffected because it received an independent copy.

### Dedup Window

The dedup window is the time period during which coalescing can occur for a given request. It begins when the owner request is registered and ends when the owner request settles (resolves or rejects) or when the maximum wait time (`maxWaitMs`) is exceeded.

If a subscriber has been waiting longer than `maxWaitMs`, it detaches from the in-flight entry and sends its own request to the LLM. This prevents a pathological scenario where a slow or hung owner request blocks all subscribers indefinitely. The default `maxWaitMs` is 30 seconds, which exceeds the typical LLM response time (1-15 seconds) but prevents unbounded waiting.

When a subscriber detaches due to timeout:
- The subscriber sends its own LLM request independently.
- The subscriber is removed from the in-flight entry's subscriber list.
- If the original owner eventually responds, the late response is discarded (no subscribers are waiting for it, and the entry is cleaned up).
- The subscriber's independent request may itself become a new owner if other requests arrive for the same identity key while it is in-flight.

### Owner and Subscriber

The **owner** is the first caller to send a request with a given identity key when no matching entry exists in the in-flight registry. The owner's function (the actual LLM API call) is executed, and the owner is responsible for producing the result that all subscribers will receive.

A **subscriber** is any subsequent caller whose request matches an existing in-flight entry. The subscriber does not call the LLM. It waits for the owner's result. From the subscriber's perspective, the call behaves identically to a direct LLM call -- it returns the same response type after a wait -- but no LLM API call is made.

The distinction between owner and subscriber is invisible to the caller. The caller calls `dedup.execute(key, fn)` or uses the wrapped client, and receives a result. Whether the caller was the owner (executed `fn`) or a subscriber (waited for another owner's `fn`) is transparent. The only observable difference is that the subscriber receives the result slightly sooner than a direct LLM call would have (because the owner's call was already in progress when the subscriber arrived).

---

## 5. How In-Flight Dedup Works

### Full Mechanism

The dedup pipeline executes the following steps for every incoming request:

**Step 1: Receive request.** The application calls `dedup.execute(key, fn)` or the cache-through wrapper intercepts a `client.chat(messages)` call. The request contains the LLM call parameters (messages, model, temperature, etc.) and either an explicit key or parameters from which the key will be computed.

**Step 2: Compute request identity.** The identity key is computed from the request parameters using the configured identity mode:
- **Exact mode (default):** `SHA-256(canonicalize(messages, model, temperature, ...))`. Computation takes under 10 microseconds.
- **Semantic mode:** `embedding = await embedder(promptText)`. Computation takes 1-500ms depending on the embedding source.
- **Custom mode:** `key = keyFn(params)`. Computation time depends on the user-provided function.

**Step 3: Check in-flight registry.** The registry is a `Map<string, InflightEntry>`. The identity key is looked up in the registry.

**Step 4a: Match found -- subscribe to existing request.** If the registry contains an entry for this identity key, the new request is a subscriber. A new Promise is created for the subscriber, and its `{ resolve, reject }` callbacks are added to the entry's subscriber list. The subscriber's Promise is returned to the caller. No LLM call is made. The dedup stats increment the `coalesced` counter.

**Step 4b: No match -- register as new owner.** If the registry does not contain an entry for this identity key, the new request is the owner. A new `InflightEntry` is created with the key, the owner's `{ resolve, reject }` callbacks, an empty subscriber list, and the start timestamp. The entry is stored in the registry. The owner's `fn` (the LLM API call) is executed. The dedup stats increment the `unique` counter.

**Step 5: Owner settles -- notify all subscribers.** When the owner's `fn` resolves or rejects:
- **On resolve:** The response is deep-cloned for each subscriber. Each subscriber's `resolve` callback is called with its own clone. The owner receives the original response.
- **On reject:** The error is cloned for each subscriber. Each subscriber's `reject` callback is called with its clone. The owner receives the original error.
- The entry is removed from the registry.
- The entry's elapsed time is recorded for stats.

**Step 6: Cleanup.** The registry entry is removed immediately on settlement. No stale entries accumulate. A background sweep (configurable, default: every 60 seconds) checks for abandoned entries (entries whose owner Promise has been pending longer than `abandonTimeoutMs`, default: 120 seconds) and removes them, rejecting all subscribers with a timeout error.

### Request Flow Diagram

```
Time →

User A: "What is the capital of France?"
  │
  ▼
┌─────────────────────────────────────┐
│  Step 2: Compute identity key       │
│  SHA-256(normalize(messages,model))  │
│  → key: "a1b2c3..."                 │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Step 3: Check registry             │
│  registry.has("a1b2c3...") → false  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Step 4b: Register as owner         │
│  registry.set("a1b2c3...", entry)   │
│  Execute fn() → call LLM           │────────────────┐
└─────────────────────────────────────┘                │
                                                       │ LLM processing
User B: "What is the capital of France?"               │ (2 seconds)
  │                                                    │
  ▼                                                    │
┌─────────────────────────────────────┐                │
│  Step 2: Compute identity key       │                │
│  → key: "a1b2c3..."                │                │
└──────────────┬──────────────────────┘                │
               │                                       │
               ▼                                       │
┌─────────────────────────────────────┐                │
│  Step 3: Check registry             │                │
│  registry.has("a1b2c3...") → true   │                │
└──────────────┬──────────────────────┘                │
               │                                       │
               ▼                                       │
┌─────────────────────────────────────┐                │
│  Step 4a: Subscribe                 │                │
│  entry.subscribers.push(B)          │                │
│  Return subscriber Promise          │                │
│  (No LLM call made)                │                │
└─────────────────────────────────────┘                │
                                                       │
User C: "What is the capital of France?"               │
  │                                                    │
  ▼                                                    │
┌─────────────────────────────────────┐                │
│  Step 4a: Subscribe                 │                │
│  entry.subscribers.push(C)          │                │
│  (No LLM call made)                │                │
└─────────────────────────────────────┘                │
                                                       │
                                        ┌──────────────┘
                                        │ LLM responds
                                        ▼
┌─────────────────────────────────────────────────────┐
│  Step 5: Owner settles                              │
│                                                     │
│  response = "The capital of France is Paris."       │
│                                                     │
│  User A: receives original response                 │
│  User B: receives structuredClone(response)         │
│  User C: receives structuredClone(response)         │
│                                                     │
│  registry.delete("a1b2c3...")                       │
│  Stats: 1 unique + 2 coalesced = 3 total            │
│  Cost savings: 2 LLM calls avoided                  │
└─────────────────────────────────────────────────────┘
```

### Result: 3 users received the answer. 1 LLM call was made. 2 calls were avoided.

---

## 6. Request Identity

### Exact Match (Default)

The default identity mode computes a SHA-256 hash of the canonicalized request parameters. The canonicalization process is identical to `llm-response-cache`:

1. Extract output-affecting parameters (messages, model, temperature, top_p, max_tokens, frequency_penalty, presence_penalty, seed, tools, tool_choice, response_format, stop, logit_bias).
2. Normalize message content (Unicode NFC, trim whitespace).
3. Normalize model identifier (lowercase).
4. Normalize numeric parameters (canonical representation).
5. Serialize with sorted keys (JSON.stringify with key sorting at every nesting level).
6. Hash with SHA-256, represent as lowercase hex string.

Parameters excluded from the key: `stream`, `stream_options`, `n`, `user`, `api_key`, `timeout`, `request_id`, `organization`. These parameters do not affect the LLM's response content.

The `stream` parameter is particularly important to exclude. A non-streaming request and a streaming request with the same prompt, model, and parameters produce the same response content -- only the delivery format differs. A streaming request should be coalesced with a non-streaming request if they are otherwise identical. The dedup layer handles the format conversion (see Section 8: Streaming Dedup).

**Identity computation overhead:** SHA-256 of a typical LLM request (1-10 KB serialized JSON) takes under 10 microseconds. Canonicalization takes under 50 microseconds. Total identity computation: under 60 microseconds per request. This is negligible compared to LLM call latency (500ms+).

### Semantic Match (Optional)

When `identityMode: 'semantic'` is configured, request identity is determined by embedding similarity rather than hash equality. The process:

1. Extract the prompt text from the request parameters (same prompt extraction as `llm-semantic-cache`).
2. Generate an embedding: `const embedding = await embedder(promptText)`.
3. For each in-flight entry, compute cosine similarity between the new embedding and the entry's embedding.
4. If any in-flight entry has similarity above `semanticThreshold` (default: 0.95), the new request subscribes to that entry.
5. If no in-flight entry exceeds the threshold, register a new entry with the computed embedding.

The cosine similarity computation is trivial for in-flight dedup because the number of in-flight entries is small -- typically single digits to low hundreds, never thousands. Even with brute-force comparison, searching 100 in-flight entries with 1536-dimensional embeddings takes under 0.1ms.

**Why the default threshold is higher for dedup (0.95) than for caching (0.92):** In-flight dedup shares a single response across all subscribers. If two prompts are "similar but not equivalent," the shared response may be subtly wrong for one of the callers. With caching, a false positive means returning a slightly mismatched cached response -- undesirable but recoverable. With dedup, a false positive means a caller never gets the "correct" response for their specific phrasing, because the owner's request uses different wording. A higher threshold reduces false positive risk.

**When to use semantic identity:** Semantic identity is useful in applications where concurrent paraphrases are common -- for example, a customer support system where multiple agents independently paraphrase the same customer question before sending it to the LLM. In most applications, concurrent identical requests (same bytes) are far more common than concurrent paraphrases, and exact matching is sufficient.

### Custom Key Function

The caller provides a `keyFn` that computes the identity key from request parameters:

```typescript
const dedup = createDedup({
  keyFn: (params) => {
    // Group by model and first user message only (ignore system prompt)
    const userMessage = params.messages.find(m => m.role === 'user')?.content;
    return `${params.model}:${userMessage}`;
  },
});
```

The custom key function receives the full request parameters and must return a string. The string is used directly as the registry key -- no hashing is applied. The caller is responsible for ensuring that the key function produces the same string for requests that should be coalesced and different strings for requests that should not.

### Why Exact Match Is Usually Sufficient

Concurrent duplicate LLM requests arise from a small set of causes:

1. **User double-click / retry:** The user clicks "Send" twice or refreshes the page. The same request is sent verbatim.
2. **Queue worker duplication:** A message queue delivers the same item to multiple workers (at-least-once delivery). The workers process the same item independently.
3. **Load balancer retry:** The load balancer retries a request that timed out, sending the same request to a different backend instance.
4. **Frontend component duplication:** Multiple UI components independently request the same LLM-generated content when a page loads.
5. **Batch overlap:** A batch processing pipeline contains duplicate items (e.g., the same document submitted twice).

All five causes produce byte-identical requests. None involves paraphrasing. Concurrent paraphrases (two different users independently phrasing the same question differently within the same 2-second window) do occur but are rare and are better handled by `llm-semantic-cache` after the response is cached. For in-flight dedup, exact matching catches the vast majority of concurrent duplicates with zero embedding cost.

---

## 7. Promise Sharing

### How Responses Are Shared

When the owner's LLM call completes, the response must be delivered to all subscribers. The implementation uses explicit resolve/reject callback management rather than Promise chaining to avoid edge cases with Promise microtask ordering and to enable per-subscriber timeout handling.

**In-flight entry structure:**

```typescript
interface InflightEntry<T = unknown> {
  key: string;
  ownerPromise: Promise<T>;
  subscribers: Array<{
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    subscribedAt: number;
    timeoutTimer?: ReturnType<typeof setTimeout>;
  }>;
  createdAt: number;
  embedding?: Float32Array;  // Only for semantic mode
}
```

**Settlement flow:**

```typescript
// When owner resolves:
const response = await ownerFn();
for (const subscriber of entry.subscribers) {
  clearTimeout(subscriber.timeoutTimer);
  subscriber.resolve(structuredClone(response));
}
registry.delete(entry.key);

// When owner rejects:
try {
  await ownerFn();
} catch (error) {
  for (const subscriber of entry.subscribers) {
    clearTimeout(subscriber.timeoutTimer);
    subscriber.reject(cloneError(error));
  }
  registry.delete(entry.key);
  throw error; // Re-throw to the owner
}
```

### Deep Clone of Response

Every subscriber receives a deep clone of the response via `structuredClone()`. This is necessary because LLM response objects are mutable plain objects. Without cloning, all subscribers would share a reference to the same object, and any modification by one subscriber would affect all others.

`structuredClone` is used instead of `JSON.parse(JSON.stringify(...))` because:
- It handles `undefined` values, `Date` objects, `ArrayBuffer`, and other types that JSON serialization loses.
- It is a native API (available in Node.js 17+) with optimized performance.
- It correctly handles circular references (unlikely in LLM responses but possible in custom wrappers).

Performance impact: `structuredClone` of a typical LLM response object (1-5 KB JSON) takes under 0.1ms. For an entry with 10 subscribers, total cloning overhead is under 1ms. This is negligible compared to the LLM call latency saved (500ms+).

### Error Propagation

When the owner request fails, all subscribers must receive the error. The error is cloned before delivery to prevent one subscriber's error handling from affecting another.

Error cloning is more nuanced than response cloning because `Error` objects have non-enumerable properties (`message`, `stack`) that `structuredClone` handles correctly in Node.js 18+. The implementation clones the error, preserving:
- `message`: The error message string.
- `name`: The error class name (e.g., `'APIError'`, `'RateLimitError'`).
- `stack`: The stack trace (from the owner's call site, not the subscriber's).
- `status` / `code`: HTTP status code or error code (common in LLM API errors).
- Custom properties: Any additional properties set by the LLM SDK (e.g., OpenAI's `error.type`, `error.param`).

The subscriber can inspect the error and decide whether to retry:

```typescript
try {
  const response = await dedupedClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [...],
  });
} catch (error) {
  // This error may have originated from the owner request, not this caller's request.
  // The caller can retry independently.
  if (error.status === 429) {
    await delay(1000);
    // Retry will go through the dedup layer again -- if another request is already
    // in-flight for the same prompt, this retry will subscribe to that one.
    const response = await dedupedClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [...],
    });
  }
}
```

### Maximum Subscribers

The `maxSubscribers` option (default: 100) limits the number of subscribers per in-flight entry. If the limit is reached, the next matching request bypasses the dedup layer and sends its own LLM call. This prevents a pathological scenario where thousands of concurrent requests for the same prompt all wait on a single owner, creating a thundering herd of `structuredClone` operations when the owner resolves.

When `maxSubscribers` is exceeded:
- The new request is dispatched to the LLM independently.
- It becomes its own owner with a new registry entry (using a suffixed key to avoid collision with the original entry).
- The dedup stats record it as a `unique` call, not `coalesced`.
- A warning is emitted via the configured logger.

---

## 8. Streaming Dedup

### The Challenge

Streaming LLM responses present a unique challenge for dedup. A stream is a sequence of chunks delivered over time, not a single value that can be cloned and distributed. Once a stream is consumed (iterated), it is exhausted -- it cannot be read again. Sharing a stream directly between owner and subscribers is not possible.

When the owner requests a streaming response, the owner's stream must be delivered to the owner in real time (preserving the streaming UX), while simultaneously being captured and replayed to subscribers who may arrive at different times during the stream.

### Buffer and Replay (Default)

The default streaming dedup strategy is buffer and replay:

1. The owner's stream is intercepted by a buffering proxy.
2. As each chunk arrives from the LLM, it is:
   a. Forwarded to the owner immediately (the owner sees the stream in real time).
   b. Appended to a buffer (an array of chunks).
3. When a subscriber arrives while the stream is in progress:
   a. All buffered chunks (chunks that arrived before the subscriber) are replayed to the subscriber immediately.
   b. Future chunks are forwarded to the subscriber as they arrive, simultaneously with the owner.
4. When the stream completes:
   a. All subscribers who have not yet received the complete stream receive the remaining chunks.
   b. The in-flight entry is removed from the registry.
   c. The complete buffer is discarded.

**Subscriber stream behavior:**

A subscriber receives an async iterable that yields:
- First: all buffered chunks that arrived before the subscriber joined (replayed rapidly).
- Then: all subsequent chunks as they arrive from the LLM (in real time, same pace as the owner).
- Finally: the stream completion signal.

From the subscriber's perspective, the stream looks like a normal LLM stream, except the first portion arrives faster than usual (because it is a replay of buffered data).

### Late Subscriber Handling

A subscriber that arrives after the stream has already completed receives the full buffered response as a rapid replay (all chunks emitted immediately in sequence), followed by the completion signal. This is functionally equivalent to a non-streaming response delivered as a synthetic stream.

A subscriber that arrives while the stream is midway receives a hybrid: a rapid replay of historical chunks, then a real-time continuation of future chunks. The transition from replay to real-time is seamless from the subscriber's perspective.

### Streaming and Non-Streaming Coalescing

When the identity key is the same (because `stream` is excluded from the identity computation), a streaming request and a non-streaming request for the same prompt may be coalesced. The implementation handles this:

- **Owner is streaming, subscriber is non-streaming:** The subscriber waits for the owner's stream to complete, then receives the assembled full response as a single non-streaming return value.
- **Owner is non-streaming, subscriber is streaming:** The subscriber waits for the owner's non-streaming response, then receives it as a synthetic stream (single chunk + completion). This is functionally equivalent to a cache hit with immediate replay mode.
- **Both streaming:** Standard buffer-and-replay as described above.
- **Both non-streaming:** Standard Promise sharing as described in Section 7.

### Disabling Streaming Dedup

If the complexity of streaming dedup is undesirable, the caller can set `streamDedup: false`. With this setting, requests with `stream: true` bypass the dedup layer entirely and go directly to the LLM. Only non-streaming requests are deduplicated.

```typescript
const dedup = createDedup({
  streamDedup: false, // Streaming requests bypass dedup
});
```

### Memory Considerations for Streaming

The buffer for a streaming response holds all chunks in memory until the stream completes and all subscribers have been notified. For a typical LLM response (500 tokens, ~2 KB of text), the buffer is small. For long responses (10,000 tokens, ~40 KB), the buffer is still manageable. The buffer is discarded immediately after settlement, so memory usage is bounded by `(number of concurrent in-flight streams) * (average stream buffer size)`.

Worst case: 100 concurrent in-flight streaming requests, each with a 40 KB buffer = 4 MB of buffer memory. This is negligible for a Node.js process.

---

## 9. Dedup Window and Timeout

### How Long Coalescing Lasts

Coalescing for a given identity key lasts from the moment the owner request is registered until the moment the owner request settles (resolves or rejects). This is the natural dedup window -- it is determined by the LLM's response time, not by a configured duration.

Typical dedup windows:
- GPT-4o with a short prompt: 1-3 seconds.
- GPT-4o with a long prompt and max_tokens=4000: 5-15 seconds.
- GPT-4 Turbo with complex reasoning: 10-30 seconds.
- A slow or overloaded LLM API: 30-60+ seconds.

During this window, any matching request subscribes to the in-flight entry. After the window closes (owner settles), the entry is removed, and the next matching request becomes a new owner.

### Subscriber Timeout (maxWaitMs)

The `maxWaitMs` option (default: 30,000ms / 30 seconds) sets the maximum time a subscriber will wait for the owner's result before giving up and sending its own request.

**Timeout behavior:**

1. When a subscriber is added, a timeout timer is started: `setTimeout(detach, maxWaitMs)`.
2. If the owner settles before the timeout, the timer is cleared, and the subscriber receives the response normally.
3. If the timeout fires before the owner settles:
   a. The subscriber is removed from the entry's subscriber list.
   b. The subscriber's Promise is rejected with a `DedupTimeoutError`.
   c. The caller's code catches the timeout and can retry independently.
   d. The retry goes through the dedup layer again -- if the original owner is still in-flight, the retry subscribes to it (and gets a new timeout). If the original owner has since settled or been removed, the retry becomes a new owner.

Alternatively, the caller can configure `timeoutBehavior: 'fallthrough'` to automatically send the subscriber's own request on timeout instead of rejecting with an error:

```typescript
const dedup = createDedup({
  maxWaitMs: 10_000,
  timeoutBehavior: 'fallthrough', // Instead of rejecting, send own request
});
```

With `fallthrough`, when the subscriber times out:
1. The subscriber is detached from the in-flight entry.
2. The subscriber's own LLM call is made independently.
3. If the original owner's response arrives before the subscriber's independent call completes, the late response is ignored (the subscriber has already moved on).

### Abandon Timeout

The `abandonTimeoutMs` option (default: 120,000ms / 2 minutes) sets the maximum lifetime of an in-flight entry. If an entry exists for longer than this duration, it is considered abandoned (the owner's Promise is hanging, likely due to a bug, network issue, or unhandled rejection). The entry is removed from the registry, and all subscribers are rejected with a `DedupAbandonError`.

The abandon sweep runs periodically (default: every 60 seconds) and checks all entries for age exceeding `abandonTimeoutMs`. This prevents memory leaks from entries whose owner Promises never settle.

---

## 10. Error Handling and Edge Cases

### Owner Request Fails

When the owner's LLM call throws an error (API error, rate limit, network failure), all subscribers receive the error. The error is cloned for each subscriber. The entry is removed from the registry.

This is the expected behavior for most error types: if the LLM is returning a 500 error, sending additional identical requests will likely produce the same error. Sharing the error prevents N redundant failed requests.

However, for transient errors (rate limit, temporary network issue), the subscribers may want to retry independently. The caller is responsible for retry logic -- `llm-dedup` does not retry. The recommended architecture is to wrap the LLM client with `llm-retry` before wrapping with `llm-dedup`:

```typescript
const retriableClient = wrapWithRetry(openai, { maxRetries: 3 });
const dedupedClient = createDedup().wrap(retriableClient);
```

With this layering, the owner's request retries up to 3 times before failing. If it ultimately fails, subscribers receive the final error. If any retry succeeds, subscribers receive the success.

### Race Condition: Request Completes Between Check and Register

A race condition can occur if the check and registration steps are not atomic: a request checks the registry, finds no match, then attempts to register -- but in the intervening time (even microseconds in a single-threaded event loop, if there is an await between check and register), another request with the same key has already registered.

This race is prevented by making the check-and-register operation synchronous (no `await` between the `Map.has()` check and the `Map.set()` registration). In exact-match mode, identity computation is synchronous (SHA-256), so the entire check-and-register path has no yield points. In semantic mode, the embedding computation is asynchronous, but the registry check and registration use a synchronous lock pattern:

```typescript
// Semantic mode: compute embedding first (async), then check-and-register (sync)
const embedding = await embedder(promptText);
// Synchronous block -- no yield points
const matchingKey = findSimilarInflight(embedding, threshold);
if (matchingKey) {
  return subscribeToEntry(matchingKey);
} else {
  return registerNewEntry(key, embedding, fn);
}
```

### Memory Leaks from Abandoned Entries

If an owner's Promise never settles (e.g., the LLM call hangs indefinitely without timing out), the registry entry persists forever, and all subscriber Promises hang forever. This is a memory leak.

Prevention:
1. **`abandonTimeoutMs`:** Background sweep removes entries older than the abandon timeout.
2. **`maxWaitMs`:** Subscribers individually time out and detach, so even if the entry persists, subscribers are not blocked forever.
3. **Explicit cleanup:** `dedup.cancelInflight(key)` removes a specific entry, rejecting all subscribers with a cancellation error. `dedup.cancelAll()` clears the entire registry.

### Concurrent Settle and Subscribe

A request may attempt to subscribe to an in-flight entry at the exact moment the entry is being settled (owner resolved, subscribers being notified, entry being removed). This is handled by checking the entry's status before subscribing:

```typescript
if (entry.settled) {
  // Entry is already settled -- treat as no match, register as new owner.
  return registerNewEntry(key, fn);
}
// Entry is still pending -- safe to subscribe.
entry.subscribers.push({ resolve, reject });
```

The `settled` flag is set synchronously before the subscriber notification loop begins, so no subscriber can be added after settlement starts.

### Subscriber Cancellation

Subscribers can cancel their wait via an `AbortSignal`:

```typescript
const controller = new AbortController();
const response = dedup.execute('key', fn, { signal: controller.signal });

// Later, if the caller no longer needs the result:
controller.abort();
```

When a subscriber is aborted:
1. The subscriber is removed from the entry's subscriber list.
2. The subscriber's Promise is rejected with an `AbortError`.
3. The owner request continues unaffected.
4. If all subscribers are removed (aborted or timed out), the owner request continues to completion but the result is discarded (the owner itself may still use the result if it is also the application caller).

---

## 11. API Surface

### Installation

```bash
npm install llm-dedup
```

### No Runtime Dependencies (Core)

The core package has zero runtime dependencies. All functionality is implemented using:

- `node:crypto` -- SHA-256 hashing for request identity.
- `structuredClone` -- Deep cloning of responses for subscribers.
- Native `Promise` and `Map` -- Concurrency and registry management.

### Factory: `createDedup`

Creates a new `LLMDedup` instance.

```typescript
import { createDedup } from 'llm-dedup';

const dedup = createDedup({
  identityMode: 'exact',       // 'exact' | 'semantic' | 'custom'
  maxWaitMs: 30_000,
  maxSubscribers: 100,
  streamDedup: true,
});
```

**Signature:**

```typescript
function createDedup(options?: LLMDedupOptions): LLMDedup;
```

### `dedup.execute(key, fn, options?)`

Coalesces concurrent calls with the same key. The first caller's `fn` is executed. Subsequent callers with the same key receive the same result.

```typescript
const response = await dedup.execute(
  'my-request-key',
  async () => {
    return await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    });
  },
);
```

This is the low-level primitive. Most users will use `dedup.wrap()` instead, which calls `dedup.execute()` internally with automatic key computation.

**Signature:**

```typescript
interface LLMDedup {
  execute<T>(
    key: string,
    fn: () => Promise<T>,
    options?: ExecuteOptions,
  ): Promise<T>;
}

interface ExecuteOptions {
  /** AbortSignal for cancelling this specific caller's wait. */
  signal?: AbortSignal;
  /** Override the default maxWaitMs for this call. */
  maxWaitMs?: number;
}
```

### `dedup.wrap(client, options?)`

Returns a proxy LLM client where all chat/completion calls are transparently coalesced.

```typescript
import { createDedup } from 'llm-dedup';
import OpenAI from 'openai';

const openai = new OpenAI();
const dedup = createDedup();
const dedupedClient = dedup.wrap(openai);

// Use exactly like the original client -- dedup is transparent
const response = await dedupedClient.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
```

The wrapper uses a JavaScript `Proxy` to intercept method calls. When `chat.completions.create` (OpenAI-style) or `messages.create` (Anthropic-style) is called:

1. Request parameters are extracted from the call arguments.
2. The identity key is computed (based on `identityMode`).
3. The in-flight registry is checked.
4. If a match exists, the caller subscribes.
5. If no match exists, the original client method is called and the request is registered.

**Signature:**

```typescript
interface LLMDedup {
  wrap<T>(
    client: T,
    options?: WrapOptions,
  ): T;
}

interface WrapOptions {
  /** Override identity mode for this wrapped client. */
  identityMode?: 'exact' | 'semantic' | 'custom';

  /** Custom key function for 'custom' identity mode. */
  keyFn?: (params: unknown) => string;

  /** Embedding function for 'semantic' identity mode. */
  embedder?: (text: string) => Promise<number[]>;

  /** Similarity threshold for 'semantic' identity mode. Default: 0.95. */
  semanticThreshold?: number;

  /** Client type. Auto-detected if not specified. */
  clientType?: 'openai' | 'anthropic' | 'custom';

  /** Custom parameter extractor for unknown client types. */
  extractParams?: (args: unknown[]) => {
    messages: unknown[];
    model: string;
    params: Record<string, unknown>;
    stream?: boolean;
  };
}
```

### `dedup.getInflight()`

Returns a snapshot of currently in-flight requests.

```typescript
const inflight = dedup.getInflight();
console.log(`In-flight requests: ${inflight.length}`);
for (const entry of inflight) {
  console.log(`  Key: ${entry.key.substring(0, 16)}...`);
  console.log(`  Subscribers: ${entry.subscriberCount}`);
  console.log(`  Elapsed: ${entry.elapsedMs}ms`);
}
```

**Signature:**

```typescript
interface LLMDedup {
  getInflight(): InflightInfo[];
}

interface InflightInfo {
  /** The identity key (truncated hash or original key). */
  key: string;
  /** Number of subscribers waiting for this request. */
  subscriberCount: number;
  /** Milliseconds since the owner request was dispatched. */
  elapsedMs: number;
  /** Timestamp when the owner request was dispatched. */
  createdAt: number;
  /** Whether this entry is for a streaming request. */
  streaming: boolean;
}
```

### `dedup.stats()`

Returns deduplication statistics.

```typescript
const stats = dedup.stats();
console.log(`Total requests: ${stats.total}`);
console.log(`Unique (owner) requests: ${stats.unique}`);
console.log(`Coalesced (subscriber) requests: ${stats.coalesced}`);
console.log(`Coalesced rate: ${(stats.coalescedRate * 100).toFixed(1)}%`);
console.log(`Estimated cost saved: $${stats.costSaved.toFixed(2)}`);
```

**Signature:**

```typescript
interface LLMDedup {
  stats(): DedupStats;
  resetStats(): void;
}

interface DedupStats {
  /** Total requests processed (unique + coalesced). */
  total: number;
  /** Requests that became owners (LLM calls made). */
  unique: number;
  /** Requests that subscribed to existing in-flight requests (LLM calls avoided). */
  coalesced: number;
  /** Fraction of total requests that were coalesced. */
  coalescedRate: number;
  /** Number of subscriber timeouts. */
  timeouts: number;
  /** Number of errors propagated to subscribers. */
  errors: number;
  /** Estimated tokens saved by coalescing. */
  tokensSaved: number;
  /** Estimated cost saved in USD by coalescing. */
  costSaved: number;
  /** Current number of in-flight entries. */
  currentInflight: number;
  /** Peak number of concurrent in-flight entries observed. */
  peakInflight: number;
}
```

### `dedup.cancelInflight(key)`

Cancels a specific in-flight entry. All subscribers are rejected with a `DedupCancelError`. The owner request continues to execute but its result is discarded.

```typescript
dedup.cancelInflight('a1b2c3...');
```

### `dedup.cancelAll()`

Cancels all in-flight entries. All subscribers in all entries are rejected.

```typescript
dedup.cancelAll();
```

### `dedup.close()`

Stops the abandon sweep timer and cancels all in-flight entries. Call this during process shutdown.

```typescript
await dedup.close();
```

### Types

```typescript
/** Full configuration for createDedup. */
interface LLMDedupOptions {
  /** How request identity is computed. Default: 'exact'. */
  identityMode?: 'exact' | 'semantic' | 'custom';

  /** Custom key function for 'custom' identity mode. */
  keyFn?: (params: unknown) => string;

  /** Embedding function for 'semantic' identity mode. */
  embedder?: (text: string) => Promise<number[]>;

  /** Similarity threshold for 'semantic' identity mode. Default: 0.95. */
  semanticThreshold?: number;

  /** Maximum time (ms) a subscriber waits before timing out. Default: 30000. */
  maxWaitMs?: number;

  /** Behavior when a subscriber times out. Default: 'reject'. */
  timeoutBehavior?: 'reject' | 'fallthrough';

  /** Maximum subscribers per in-flight entry. Default: 100. */
  maxSubscribers?: number;

  /** Whether streaming requests participate in dedup. Default: true. */
  streamDedup?: boolean;

  /** Maximum lifetime (ms) of an in-flight entry before it is abandoned. Default: 120000. */
  abandonTimeoutMs?: number;

  /** Interval (ms) between abandon sweeps. Default: 60000. */
  abandonSweepIntervalMs?: number;

  /** Model prices for cost tracking. */
  modelPrices?: Record<string, { input: number; output: number }>;

  /** Function to estimate token count from text. Default: text.length / 4. */
  tokenEstimator?: (text: string) => number;

  /** Optional prompt normalizer applied before identity computation. */
  normalizer?: (text: string) => string;

  /** Logger for warnings (maxSubscribers exceeded, abandon sweep, etc.). */
  logger?: {
    warn: (message: string) => void;
    debug?: (message: string) => void;
  };
}

/** Error thrown when a subscriber times out. */
class DedupTimeoutError extends Error {
  readonly code = 'DEDUP_TIMEOUT';
  readonly key: string;
  readonly waitedMs: number;
}

/** Error thrown when an in-flight entry is abandoned. */
class DedupAbandonError extends Error {
  readonly code = 'DEDUP_ABANDON';
  readonly key: string;
  readonly ageMs: number;
}

/** Error thrown when an in-flight entry is cancelled. */
class DedupCancelError extends Error {
  readonly code = 'DEDUP_CANCEL';
  readonly key: string;
}
```

---

## 12. Cost Savings Tracking

### What Is Tracked

Every coalesced request avoids one LLM API call. The cost of each avoided call is estimated using the same approach as `llm-response-cache`:

- **Tokens saved per coalesced request:** The input token count is estimated from the prompt text length (default: `text.length / 4`). The output token count is estimated from the response text length when available (after the owner's response is received) or from a configured average response size.
- **Cost saved per coalesced request:** `(inputTokens / 1_000_000 * inputPrice) + (outputTokens / 1_000_000 * outputPrice)`.
- **Cumulative tracking:** `stats.tokensSaved` and `stats.costSaved` accumulate over the lifetime of the `LLMDedup` instance. Reset with `dedup.resetStats()`.

### When Cost Is Computed

Cost is computed when the owner's request settles successfully. At that point, the response is available, and the output token count can be estimated from the actual response text. For each subscriber that was coalesced, the per-request cost savings is computed and added to the cumulative total.

### Integration with model-price-registry

```typescript
import { createDedup } from 'llm-dedup';
import { getPrice } from 'model-price-registry';

const dedup = createDedup({
  modelPrices: {
    'gpt-4o': getPrice('gpt-4o'),              // { input: 2.50, output: 10.00 }
    'gpt-4o-mini': getPrice('gpt-4o-mini'),     // { input: 0.15, output: 0.60 }
  },
});
```

If `model-price-registry` is not installed, the dedup layer uses built-in default prices for common models and falls back to `{ input: 1.00, output: 2.00 }` per million tokens for unknown models.

### Built-In Model Prices

| Model | Input ($/MTok) | Output ($/MTok) |
|---|---|---|
| `gpt-4o` | 2.50 | 10.00 |
| `gpt-4o-mini` | 0.15 | 0.60 |
| `gpt-4-turbo` | 10.00 | 30.00 |
| `gpt-3.5-turbo` | 0.50 | 1.50 |
| `claude-sonnet-4-20250514` | 3.00 | 15.00 |
| `claude-3-5-sonnet-20241022` | 3.00 | 15.00 |
| `claude-3-haiku-20240307` | 0.25 | 1.25 |

### Cost Savings Example

A chatbot receives 100 identical requests for "What is the new PTO policy?" within a 5-second burst. Without dedup, 100 LLM calls are made. With dedup, 1 LLM call is made and 99 are coalesced.

```
Model: gpt-4o
Prompt tokens: ~50 (estimated from message length)
Response tokens: ~200 (estimated from response length)
Cost per call: (50/1M * $2.50) + (200/1M * $10.00) = $0.000125 + $0.002 = $0.002125
Calls saved: 99
Cost saved this burst: 99 * $0.002125 = $0.21

Over a day with 50 such bursts: $10.50/day = $3,832/year
```

---

## 13. Configuration

### All Options with Defaults

| Option | Type | Default | Description |
|---|---|---|---|
| `identityMode` | `'exact' \| 'semantic' \| 'custom'` | `'exact'` | How request identity is computed |
| `keyFn` | `(params) => string` | `undefined` | Custom identity function (required if `identityMode: 'custom'`) |
| `embedder` | `(text) => Promise<number[]>` | `undefined` | Embedding function (required if `identityMode: 'semantic'`) |
| `semanticThreshold` | `number` | `0.95` | Cosine similarity threshold for semantic mode |
| `maxWaitMs` | `number` | `30000` | Maximum subscriber wait time in milliseconds |
| `timeoutBehavior` | `'reject' \| 'fallthrough'` | `'reject'` | What happens when a subscriber times out |
| `maxSubscribers` | `number` | `100` | Maximum subscribers per in-flight entry |
| `streamDedup` | `boolean` | `true` | Whether streaming requests participate in dedup |
| `abandonTimeoutMs` | `number` | `120000` | Maximum in-flight entry lifetime before abandonment |
| `abandonSweepIntervalMs` | `number` | `60000` | Interval between abandon sweeps |
| `modelPrices` | `Record<string, { input: number; output: number }>` | built-in defaults | Per-model token prices in USD per million tokens |
| `tokenEstimator` | `(text: string) => number` | `text.length / 4` | Function to estimate token count from text |
| `normalizer` | `(text: string) => string` | `undefined` | Prompt normalizer (e.g., from `prompt-dedup`) |
| `logger` | `{ warn, debug? }` | `console` | Logger for warnings and debug messages |

### Configuration Examples

**Minimal (default exact matching):**

```typescript
const dedup = createDedup();
```

**With semantic identity:**

```typescript
const dedup = createDedup({
  identityMode: 'semantic',
  embedder: async (text) => {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return res.data[0].embedding;
  },
  semanticThreshold: 0.95,
});
```

**With aggressive timeout for latency-sensitive apps:**

```typescript
const dedup = createDedup({
  maxWaitMs: 5_000,
  timeoutBehavior: 'fallthrough',
});
```

**With prompt normalization:**

```typescript
import { normalize } from 'prompt-dedup';

const dedup = createDedup({
  normalizer: normalize,
});
```

---

## 14. Integration with Monorepo Packages

### llm-response-cache

`llm-response-cache` caches completed responses for future requests (sequential dedup). `llm-dedup` coalesces in-flight requests (concurrent dedup). The two are complementary. The recommended layering order is: dedup wraps the cached client, so that:

1. A request arrives.
2. The dedup layer checks its in-flight registry.
3. If an identical request is already in-flight, the caller subscribes (dedup hit).
4. If no match in-flight, the request falls through to the cache layer.
5. The cache layer checks its cache. If the prompt was cached previously, it returns the cached response (cache hit).
6. If no cache hit, the request goes to the LLM.
7. When the LLM responds, the cache stores the response, and the dedup layer notifies all subscribers.

```typescript
import { createDedup } from 'llm-dedup';
import { createCache } from 'llm-response-cache';
import OpenAI from 'openai';

const openai = new OpenAI();
const cache = createCache({ maxEntries: 10_000 });
const dedup = createDedup();

// Layer: dedup → cache → LLM
const cachedClient = cache.wrap(openai);
const dedupedClient = dedup.wrap(cachedClient);

// All calls go through: dedup check → cache check → LLM
const response = await dedupedClient.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
```

This layering means:
- **Sequential duplicate (same prompt, 5 minutes later):** Cache hit. No LLM call.
- **Concurrent duplicate (same prompt, 200ms later, cache still empty):** Dedup hit. One LLM call, shared result.
- **Unique prompt:** Cache miss + dedup miss. LLM call, response cached for future.

### llm-semantic-cache

`llm-semantic-cache` caches semantically similar responses. `llm-dedup` coalesces in-flight requests. In a full caching stack:

```typescript
import { createDedup } from 'llm-dedup';
import { createCache as createExactCache } from 'llm-response-cache';
import { createCache as createSemanticCache } from 'llm-semantic-cache';

// Layer order: dedup → exact cache → semantic cache → LLM
const semanticCachedClient = semanticCache.wrap(openai);
const exactCachedClient = exactCache.wrap(semanticCachedClient);
const dedupedClient = dedup.wrap(exactCachedClient);
```

This four-layer stack handles:
1. **Concurrent identical requests:** Dedup (in-flight coalescing).
2. **Sequential identical requests:** Exact cache (hash match).
3. **Sequential paraphrased requests:** Semantic cache (embedding similarity).
4. **Truly unique requests:** LLM call.

### prompt-dedup

`prompt-dedup` normalizes prompts via text-level transformations. Applying normalization before identity computation increases the chance of exact matches between prompts that differ only in formatting:

```typescript
import { normalize } from 'prompt-dedup';
import { createDedup } from 'llm-dedup';

const dedup = createDedup({
  normalizer: normalize,
});
// "What is the capital  of   France?" and "What is the capital of France?"
// now produce the same identity key.
```

### ai-keyring

`ai-keyring` manages LLM API keys. `llm-dedup` is key-agnostic: the identity key excludes API credentials, so requests with different API keys but identical prompts are coalesced. This is correct because different API keys for the same model and parameters produce the same response. If key isolation is needed (e.g., per-tenant billing), include a tenant identifier in the identity key via a custom key function.

### llm-retry

`llm-retry` retries failed LLM requests with exponential backoff. The recommended ordering is retry inside dedup:

```typescript
const retriableClient = wrapWithRetry(openai, { maxRetries: 3 });
const dedupedClient = dedup.wrap(retriableClient);
```

With this ordering:
- If the LLM call fails, `llm-retry` retries it (up to 3 times).
- All subscribers wait for the retry to complete.
- If all retries fail, all subscribers receive the final error.
- Subscribers never independently retry -- they share the owner's retry lifecycle.

---

## 15. Testing Strategy

### Unit Tests

- **Identity computation (exact):** Test that identical request parameters produce the same key. Test that parameters differing in any output-affecting field produce different keys. Test that parameters differing only in `stream`, `user`, or `api_key` produce the same key. Test JSON key order independence. Test whitespace normalization. Test Unicode NFC normalization.
- **Identity computation (semantic):** Test that similar prompts (cosine similarity above threshold) produce a match. Test that dissimilar prompts do not match. Test threshold boundary behavior.
- **Registry operations:** Test `set`, `has`, `get`, `delete`. Test that `has` returns false after deletion. Test that entries do not leak after settlement.
- **Promise sharing:** Test that all subscribers receive the same response (deep equal but not reference equal). Test that each subscriber gets an independent clone (mutating one does not affect another).
- **Error propagation:** Test that owner failure rejects all subscribers. Test that the error is cloned (not shared by reference). Test that error properties (`message`, `name`, `status`, `code`) are preserved.
- **Timeout:** Test that a subscriber rejects after `maxWaitMs`. Test that `timeoutBehavior: 'fallthrough'` sends an independent request. Test that the owner continues unaffected after subscriber timeout.
- **Abandon sweep:** Test that entries older than `abandonTimeoutMs` are removed. Test that all subscribers of abandoned entries receive `DedupAbandonError`.
- **Max subscribers:** Test that the (N+1)th subscriber bypasses dedup when `maxSubscribers: N`.
- **Stats:** Test that `total`, `unique`, `coalesced`, `coalescedRate`, `costSaved` are computed correctly. Test `resetStats`.
- **Token estimation:** Test the default estimator (`text.length / 4`) with known text-token pairs.
- **Cost computation:** Test per-coalesced-request cost calculation with known token counts and model prices.

### Concurrency Tests

- **Basic coalescing:** Launch N concurrent calls with the same key. Assert that `fn` is called exactly once. Assert that all N callers receive the same response (deep equal).
- **Different keys:** Launch N concurrent calls with K different keys. Assert that `fn` is called exactly K times.
- **Mixed keys:** Launch calls with a mix of identical and different keys. Assert correct coalescing behavior.
- **Rapid sequential:** Launch calls in rapid sequence (not concurrent, but before the first settles). Assert coalescing.
- **Settlement timing:** Assert that subscribers are notified in the same event loop tick as the owner's resolution (microtask ordering).
- **Race between settle and subscribe:** Simulate a subscription arriving at the exact moment of settlement. Assert correct behavior (no duplicate notification, no missed notification).

### Streaming Tests

- **Streaming owner with streaming subscriber:** Verify subscriber receives all chunks in order. Verify chunk timing (buffered chunks arrive faster, real-time chunks arrive at LLM pace).
- **Streaming owner with non-streaming subscriber:** Verify subscriber receives the assembled full response after stream completes.
- **Non-streaming owner with streaming subscriber:** Verify subscriber receives a synthetic stream (single chunk).
- **Late subscriber:** Verify a subscriber joining mid-stream receives buffered + real-time chunks.
- **Post-completion subscriber:** Verify behavior when subscribing after the stream has already completed.
- **Stream error:** Verify that a stream error (mid-stream failure) propagates to all subscribers.
- **`streamDedup: false`:** Verify streaming requests bypass dedup.

### Integration Tests

- **End-to-end with mock LLM client:** Wrap a mock client with `dedup.wrap()`. Send concurrent identical requests. Assert one mock call, all callers receive the response.
- **End-to-end with llm-response-cache:** Layer dedup on cache. Verify that concurrent cache misses result in one LLM call (dedup handles the concurrency), and subsequent sequential requests are cache hits.
- **AbortSignal cancellation:** Verify that aborting a subscriber does not affect the owner or other subscribers.
- **Process shutdown:** Verify that `dedup.close()` cleans up timers and rejects pending subscribers.

### Performance Tests

- **Identity computation overhead:** Benchmark SHA-256 key computation for requests of various sizes. Assert under 100 microseconds for a 10 KB request.
- **Registry lookup overhead:** Benchmark `Map.has()` + `Map.get()` for registries of various sizes. Assert under 1 microsecond.
- **Total dedup overhead (per request):** Benchmark the full pipeline (identity computation + registry check + response cloning) for a dedup hit. Assert under 0.5ms total.
- **Clone overhead:** Benchmark `structuredClone` for response objects of various sizes (1 KB, 5 KB, 20 KB). Assert under 0.5ms for 20 KB.
- **Memory under load:** Measure memory usage with 100, 1,000, and 10,000 concurrent in-flight entries. Assert linear scaling.
- **Throughput:** Benchmark requests per second with dedup enabled vs. disabled. Assert that dedup overhead is under 1% of total request time.

### Edge Case Tests

- **Zero concurrent overlap:** All requests have unique keys. Dedup is a pass-through. Assert no coalescing, no overhead beyond identity computation.
- **100% concurrent overlap:** All requests have the same key. Assert one LLM call, N-1 coalesced.
- **Empty registry:** `getInflight()` returns empty array. `stats()` returns zeros.
- **Single request:** One request, no concurrency. Assert it becomes the owner, executes normally, stats show 1 unique / 0 coalesced.
- **fn throws synchronously:** The owner's function throws (not rejects). Assert correct error propagation.
- **fn returns non-Promise:** The owner's function returns a value instead of a Promise. Assert correct handling (auto-wrap in resolved Promise).
- **Undefined/null response:** The owner's function resolves with `undefined` or `null`. Assert subscribers receive `undefined`/`null` (not an error).
- **Very large subscriber count:** 1,000 subscribers on a single entry. Assert all receive the response without excessive memory usage or event loop blocking.

---

## 16. Performance

### Dedup Hit Latency Breakdown

| Step | Latency |
|---|---|
| Request parameter canonicalization | < 0.05ms |
| SHA-256 identity computation | < 0.01ms |
| Registry lookup (`Map.has`) | < 0.001ms |
| Subscriber registration | < 0.001ms |
| **Total dedup hit overhead** | **< 0.07ms** |

For comparison:
- LLM API call: 500-5,000ms
- Response cache hit: < 0.1ms
- Semantic cache hit: 2-10ms

The dedup overhead on a hit is negligible. The subscriber spends virtually all its time waiting for the owner's LLM call, not in dedup logic.

### Dedup Miss Latency Breakdown

On a dedup miss (no matching in-flight entry, request becomes the owner):

| Step | Added Latency |
|---|---|
| Canonicalization + identity | < 0.07ms |
| Registry registration (`Map.set`) | < 0.001ms |
| Response cloning (per subscriber, on resolve) | < 0.1ms per subscriber |
| Registry cleanup (`Map.delete`) | < 0.001ms |
| **Total dedup miss overhead** | **< 0.08ms + 0.1ms per subscriber** |

For a request with 10 subscribers, the total overhead at settlement is approximately 1ms (10 clones). This is under 0.2% of a typical LLM call latency.

### Memory Usage

The in-flight registry is ephemeral. Entries exist only for the duration of LLM calls (typically 1-30 seconds) and are removed immediately on settlement. Memory usage is bounded by:

```
registry memory ≈ (number of concurrent in-flight unique keys) * (entry overhead)
entry overhead ≈ 200 bytes (key + timestamps + metadata) + 50 bytes per subscriber
```

| Concurrent Unique In-Flight | Avg Subscribers | Registry Memory |
|---|---|---|
| 10 | 5 | ~4.5 KB |
| 100 | 5 | ~45 KB |
| 1,000 | 5 | ~450 KB |
| 10,000 | 5 | ~4.5 MB |

Even at extreme concurrency (10,000 unique in-flight requests, each with 5 subscribers), the registry uses under 5 MB. This is negligible for a Node.js process.

For streaming dedup, add the stream buffer memory:

| Concurrent Streams | Avg Buffer Size | Buffer Memory |
|---|---|---|
| 10 | 5 KB | 50 KB |
| 100 | 5 KB | 500 KB |
| 1,000 | 5 KB | 5 MB |

### Overhead Comparison

| Scenario | Without Dedup | With Dedup | Overhead |
|---|---|---|---|
| 10 identical concurrent requests | 10 LLM calls (5,000ms each, $0.02 each) | 1 LLM call + 9 subscribes | < 1ms added, $0.18 saved |
| 100 unique requests, no overlap | 100 LLM calls | 100 LLM calls | < 7ms total overhead |
| 50% overlap, 200 requests | 200 LLM calls | 100 LLM calls + 100 subscribes | < 10ms total overhead, $2.00 saved |

The dedup layer adds sub-millisecond overhead per request and saves hundreds of milliseconds to seconds per coalesced request by avoiding redundant LLM calls.

---

## 17. Dependencies

### Runtime Dependencies (Core)

None. The core package has zero runtime dependencies. All functionality is implemented using:

- `node:crypto` -- SHA-256 hashing for request identity in exact mode.
- `structuredClone` -- Deep cloning of responses (global, available Node.js 17+).
- `Map` -- In-flight registry.
- `Promise` -- Concurrency primitives.
- `setTimeout` / `clearTimeout` -- Timeout management.

### Dev Dependencies

| Package | Purpose |
|---|---|
| `typescript` | TypeScript compiler |
| `vitest` | Test runner |
| `eslint` | Linter |

### Integration Dependencies (Optional, from Monorepo)

| Package | Purpose |
|---|---|
| `llm-response-cache` | Layer persistent cache behind dedup for sequential + concurrent dedup |
| `llm-semantic-cache` | Layer semantic cache behind dedup for paraphrase + concurrent dedup |
| `prompt-dedup` | Normalize prompts before identity computation to increase match rates |
| `model-price-registry` | Up-to-date model pricing for cost tracking |
| `llm-retry` | Retry failed requests (wrap client with retry before dedup) |
| `ai-keyring` | API key management (dedup is key-agnostic) |

---

## 18. File Structure

```
llm-dedup/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── dedup.ts                  # LLMDedup class -- core dedup logic
│   ├── registry.ts               # In-flight registry (Map management, entry lifecycle)
│   ├── identity.ts               # Request identity computation (exact, semantic, custom)
│   ├── normalize.ts              # Request parameter canonicalization (shared with llm-response-cache)
│   ├── clone.ts                  # Response and error cloning utilities
│   ├── stream.ts                 # Streaming dedup (buffer, replay, tee)
│   ├── wrapper/
│   │   ├── wrap.ts               # dedup.wrap() implementation -- Proxy-based
│   │   ├── openai.ts             # OpenAI client adapter (parameter extraction, identity)
│   │   └── anthropic.ts          # Anthropic client adapter
│   ├── stats.ts                  # Dedup statistics and cost tracking
│   ├── errors.ts                 # DedupTimeoutError, DedupAbandonError, DedupCancelError
│   ├── types.ts                  # All TypeScript type definitions
│   └── __tests__/
│       ├── dedup.test.ts         # Core dedup logic tests
│       ├── registry.test.ts      # Registry lifecycle tests
│       ├── identity.test.ts      # Identity computation tests (exact, semantic, custom)
│       ├── normalize.test.ts     # Canonicalization tests
│       ├── clone.test.ts         # Cloning tests (response, error)
│       ├── stream.test.ts        # Streaming dedup tests
│       ├── wrapper.test.ts       # Proxy wrapper tests (OpenAI, Anthropic)
│       ├── stats.test.ts         # Stats and cost tracking tests
│       ├── concurrency.test.ts   # Concurrent execution tests
│       ├── timeout.test.ts       # Timeout and abandon tests
│       └── edge-cases.test.ts    # Edge case tests
├── package.json
├── tsconfig.json
├── SPEC.md
└── README.md
```

---

## 19. Implementation Roadmap

### Phase 1: Core Dedup (MVP)

1. **Request identity (exact mode)** (`identity.ts`, `normalize.ts`). Canonicalization of request parameters, JSON serialization with sorted keys, SHA-256 hashing. Reuse the canonicalization logic from `llm-response-cache` or implement a compatible version. Extensive unit tests with known input-output pairs verifying key determinism and parameter sensitivity.
2. **In-flight registry** (`registry.ts`). `Map<string, InflightEntry>` with `register`, `subscribe`, `settle`, `remove` operations. Atomic check-and-register to prevent race conditions.
3. **Core dedup logic** (`dedup.ts`). `createDedup`, `execute`, `getInflight`, `stats`. Promise sharing with `structuredClone` for subscribers. Error propagation with error cloning.
4. **Response and error cloning** (`clone.ts`). `structuredClone`-based cloning with fallback for environments where `structuredClone` is not available.
5. **Error classes** (`errors.ts`). `DedupTimeoutError`, `DedupAbandonError`, `DedupCancelError`.
6. **Types** (`types.ts`). All interfaces: `LLMDedupOptions`, `DedupStats`, `InflightEntry`, `InflightInfo`, `ExecuteOptions`.
7. **Public API exports** (`index.ts`). Export `createDedup` and all types.
8. **Unit and concurrency tests** for all above.

### Phase 2: Timeout and Lifecycle

1. **Subscriber timeout** (`dedup.ts`). `maxWaitMs`, `timeoutBehavior: 'reject' | 'fallthrough'`. Per-subscriber timeout timers. Cleanup on detach.
2. **Abandon sweep** (`registry.ts`). Background interval that checks entry age and removes abandoned entries. Configurable interval and threshold.
3. **Cancellation** (`dedup.ts`). `cancelInflight(key)`, `cancelAll()`, `close()`. AbortSignal support on `execute`.
4. **Max subscribers** (`dedup.ts`). Enforce limit, overflow to independent request.
5. **Tests** for timeout, abandon, cancellation, and max subscribers.

### Phase 3: Client Wrapper

1. **Proxy-based wrapper** (`wrapper/wrap.ts`). `dedup.wrap(client)` returning a Proxy that intercepts `chat.completions.create` (OpenAI) and `messages.create` (Anthropic).
2. **OpenAI adapter** (`wrapper/openai.ts`). Parameter extraction, identity key computation, response format passthrough.
3. **Anthropic adapter** (`wrapper/anthropic.ts`). Same for Anthropic client interface.
4. **Client auto-detection** (`wrapper/wrap.ts`). Detect client type from object shape.
5. **Integration tests** with mock clients.

### Phase 4: Streaming Dedup

1. **Stream buffer** (`stream.ts`). Buffer and replay mechanism for streaming responses. Chunk array with subscriber management.
2. **Late subscriber replay** (`stream.ts`). Replay buffered chunks to subscribers who arrive mid-stream.
3. **Mixed streaming/non-streaming coalescing** (`stream.ts`). Handle cases where owner and subscriber use different streaming modes.
4. **`streamDedup: false` mode** (`dedup.ts`). Bypass for streaming requests.
5. **Streaming tests** with mock streams and various subscriber timing patterns.

### Phase 5: Semantic Identity and Cost Tracking

1. **Semantic identity mode** (`identity.ts`). Embedding-based identity with cosine similarity. In-flight embedding registry.
2. **Custom identity mode** (`identity.ts`). User-provided key function support.
3. **Cost tracking** (`stats.ts`). Token estimation, model pricing, per-coalesced-request cost computation, cumulative stats.
4. **Integration with `model-price-registry`** (`stats.ts`). Optional import for accurate pricing.
5. **Tests** for semantic identity, custom identity, and cost tracking.

### Phase 6: Polish and Documentation

1. **README.md** with quick-start guide, API reference, integration examples, and architecture diagram.
2. **Performance benchmarks** published in README.
3. **Edge case hardening** based on real-world usage patterns.
4. **Prompt normalization integration** with `prompt-dedup`.

---

## 20. Example Use Cases

### Cache Stampede Prevention

A chatbot using `llm-response-cache` is deployed to a new environment with an empty cache. In the first minute, 500 users send popular questions. Without dedup, all 500 go to the LLM. With dedup, concurrent duplicates are coalesced.

```typescript
import { createDedup } from 'llm-dedup';
import { createCache } from 'llm-response-cache';
import OpenAI from 'openai';

const openai = new OpenAI();
const cache = createCache({
  storage: { type: 'sqlite', path: './cache.db' },
  maxEntries: 50_000,
});
const dedup = createDedup();

// Dedup wraps the cached client
const client = dedup.wrap(cache.wrap(openai));

// Cold start: 500 requests, 50 unique prompts, avg 10 concurrent per prompt
// Without dedup: 500 LLM calls ($1.06)
// With dedup: 50 LLM calls ($0.106) + 450 coalesced
// After first responses are cached: all subsequent requests are cache hits
```

### High-Traffic FAQ Bot

A company-wide FAQ bot handles HR and IT questions. Popular questions like "How do I reset my password?" arrive in bursts.

```typescript
import { createDedup } from 'llm-dedup';
import OpenAI from 'openai';

const openai = new OpenAI();
const dedup = createDedup({
  maxWaitMs: 15_000,      // Don't wait more than 15 seconds
  maxSubscribers: 50,     // Cap at 50 concurrent identical requests
});
const client = dedup.wrap(openai);

// Handle incoming user questions
app.post('/ask', async (req, res) => {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: 'You are a company FAQ assistant.' },
      { role: 'user', content: req.body.question },
    ],
  });
  res.json({ answer: response.choices[0].message.content });
});

// When 30 employees ask "How do I reset my password?" in 5 seconds:
// 1 LLM call is made, 29 are coalesced
// All 30 get the same answer within 2-3 seconds
// Cost: $0.0002 instead of $0.006
```

### Batch Processing with Overlap

A content moderation pipeline processes user posts. Many posts are identical (common short responses).

```typescript
import { createDedup } from 'llm-dedup';
import OpenAI from 'openai';

const openai = new OpenAI();
const dedup = createDedup();
const client = dedup.wrap(openai);

async function moderateBatch(posts: string[]) {
  const results = await Promise.all(
    posts.map(post =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: 'Classify this post as safe or unsafe.' },
          { role: 'user', content: post },
        ],
      })
    )
  );
  return results.map(r => r.choices[0].message.content);
}

// Batch of 1,000 posts with 200 unique texts:
// Without dedup: 1,000 LLM calls
// With dedup: 200 LLM calls + 800 coalesced
// Savings: 80% reduction in API calls
```

### API Gateway Coalescing

An API gateway proxies LLM requests from multiple frontend microservices. When a page loads, 3 microservices independently request the same LLM-generated content.

```typescript
import { createDedup } from 'llm-dedup';
import OpenAI from 'openai';

const openai = new OpenAI();
const dedup = createDedup({
  maxWaitMs: 10_000,
  timeoutBehavior: 'fallthrough', // If owner is slow, fall through
});
const client = dedup.wrap(openai);

// Gateway handler
app.post('/llm/proxy', async (req, res) => {
  const response = await client.chat.completions.create(req.body);
  res.json(response);
});

// When 3 microservices send the same request within 100ms:
// 1 LLM call is made, 2 are coalesced
// All 3 microservices receive responses within milliseconds of each other
```

### Streaming Dedup for Collaborative Editing

Multiple users in a collaborative editor request the same AI suggestion simultaneously.

```typescript
import { createDedup } from 'llm-dedup';
import OpenAI from 'openai';

const openai = new OpenAI();
const dedup = createDedup({ streamDedup: true });
const client = dedup.wrap(openai);

// User A and User B both request a suggestion for the same paragraph
async function handleSuggestionRequest(userId: string, paragraph: string) {
  const stream = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Suggest improvements for this paragraph.' },
      { role: 'user', content: paragraph },
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    sendToUser(userId, chunk.choices[0]?.delta?.content || '');
  }
}

// User A's request becomes the owner (sent to LLM, streamed in real time)
// User B's request subscribes (receives buffered + real-time chunks)
// Both users see the suggestion streaming in -- User B may see a brief burst
// of buffered chunks followed by real-time streaming
// Result: 1 LLM call instead of 2
```

### Monitoring and Observability

Track dedup effectiveness over time.

```typescript
import { createDedup } from 'llm-dedup';

const dedup = createDedup();

// Periodic stats reporting
setInterval(() => {
  const stats = dedup.stats();
  metrics.gauge('dedup.total_requests', stats.total);
  metrics.gauge('dedup.unique_requests', stats.unique);
  metrics.gauge('dedup.coalesced_requests', stats.coalesced);
  metrics.gauge('dedup.coalesced_rate', stats.coalescedRate);
  metrics.gauge('dedup.cost_saved', stats.costSaved);
  metrics.gauge('dedup.current_inflight', stats.currentInflight);
  metrics.gauge('dedup.peak_inflight', stats.peakInflight);
  metrics.gauge('dedup.timeouts', stats.timeouts);
  dedup.resetStats();
}, 60_000);

// Alert on high inflight count (may indicate LLM slowdown)
setInterval(() => {
  const inflight = dedup.getInflight();
  if (inflight.length > 1000) {
    alert(`High in-flight count: ${inflight.length} entries`);
  }
  for (const entry of inflight) {
    if (entry.elapsedMs > 60_000) {
      alert(`Long-running in-flight entry: ${entry.key} (${entry.elapsedMs}ms)`);
    }
  }
}, 10_000);
```
