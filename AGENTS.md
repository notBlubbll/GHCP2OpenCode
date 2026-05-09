# AGENTS.md

## GHCP2OpenCode Proxy

Ollama-emulating proxy that connects **GitHub Copilot Chat & Agent** (VS 2026 / VS Code) to the [OpenCode](https://opencode.ai) Zen + Go APIs + free models. Exposes an Ollama-compatible HTTP API on `localhost:11434` so the GitHub Copilot extension's built-in Ollama provider can use OpenCode models.

**Runtime:** Bun (preferred) → Node.js fallback. Framework: Hono.

---

## Architecture

```
VS 2026 / VS Code                    GHCP2OpenCode Proxy                 Upstream APIs
─────────────────                    ──────────────────                  ─────────────
GitHub Copilot extension             src/server.js                       OpenCode Zen (free)
  │  Ollama provider                   │  Hono HTTP server                 │  https://opencode.ai/zen/v1
  │  → /api/tags                       │  → model registry                 │
  │  → /v1/chat/completions            │  → chat completion                │
  │  → /api/chat                       │  → compression                    │  OpenCode Go (paid)
  ▼                                    │  → caching                        │  https://opencode.ai/zen/go/v1
                                    ┌───┴──────────────┐                  │
                                    │ Client detection  │                  │
                                    │ ├─ isVS2026()     │                  │  Pollinations (free)
                                    │ ├─ isVSCode()     │                  │  https://text.pollinations.ai/openai
                                    │ └─ LocalPilot     │                  │
                                    └───┬──────────────┘                  │
                                        │                                  │  M365 Copilot (opt)
                                    ┌───┴──────────────┐                  │  ws://127.0.0.1:8765
                                    │ Model routing     │                  │  → substrate.office.com
                                    │ ├─ M365 → relay   │                  │
                                    │ ├─ Free → Zen     │                  │
                                    │ ├─ Poll → Poll.   │                  │
                                    │ └─ Paid → Go      │                  │
                                    └───┬──────────────┘                  │
                                        │                                  │
                                    ┌───┴──────────────┐                  │
                                    │ Concurrency mgr   │                  │
                                    │ ├─ thinking queue │                  │
                                    │ └─ standard queue │                  │
                                    └───┬──────────────┘                  │
                                        │                                  │
                                    ┌───┴──────────────┐                  │
                                    │ Response pipeline │                  │
                                    │ ├─ tool extraction│                  │
                                    │ ├─ think parsing  │                  │
                                    │ └─ SSE formatting │                  │
                                    └──────────────────┘                  ▼
```

---

## Source Files

### `src/server.js` (1870 lines)
**Main entry point.** HTTP routing, request orchestration, response formatting.

- `isVSCode(c)` / `isVS2026(c)` — client detection from User-Agent
- `extractVSContext()` / `getWorkspaceRoot()` / `getActiveFile()` — extract workspace paths from VS context blocks
- `extractToolCalls()` — parse AI response text into tool calls (markdown blocks → `create_file`)
- `processThinkTags()` — `<think>` tag extraction for DeepSeek reasoning
- `_simStream()` — simulated SSE streaming from non-stream responses (VS 2026)
- `_cacheReasoning()` / `_getReasoning()` — per-message reasoning cache (DeepSeek)
- `normalizeOpenAIParams()` — camelCase → snake_case parameter mapping
- `sanitizeContent()` — strip `<|im_start|>`, `<|im_end|>` tokens
- `mapModel(name)` — resolve model names, strip `[FREE]`/`[GO]`/`[M365]` prefixes

### `src/opencode-client.js` (1204 lines)
**Model registry + upstream API communication.**

- `config` — env-var-backed configuration getters
- `initModels()` — bootstrap model list (disk cache → fetch → background refresh)
- `getModels()` / `refreshModels()` / `validateFreeModels()` — model lifecycle
- `resolveModel(name)` / `resolveModelMetadata(modelId)` — model lookup with metadata inference
- `chatCompletion(req)` — **async generator** for SSE streaming from upstream
- `zenRequest(endpoint, body, opts)` — upstream HTTP with key rotation, retry, cooldown
- `isKnownModel()` / `isFreeTierModel()` / `isPollModel()` / `isSeparator()` / `isM365Model()` — model classifiers
- `APIError` — structured error with OpenAI-compatible codes
- `getKeyStatus()` / `rotateKey()` — API key management

### `src/m365-client.js` (303 lines)
**WebSocket client for Microsoft 365 Copilot relay.**

- `m365ChatCompletion(modelId, messages)` — non-streaming M365 chat
- `m365ChatCompletionStream(modelId, messages)` — async generator for streaming
- `isM365Available()` — check if `M365CO_PORT` or `M365C_PORT` is configured
- `getM365Models()` — two models: `m365-copilot-quick` (gpt-5.5-quick) and `m365-copilot-think` (gpt-5.5-think-deeper)
- `getM365RelayModel(modelId)` — map proxy model ID to relay model string
- `buildM365ChatText(payload)` — fold system prompts + conversation history into labeled plain text with `---` separator
- `relayChatStream(payload, modelId)` — shared persistent WebSocket, serialized per-turn via `_sendGate`

### `src/concurrency.js` (312 lines)
**Concurrency limiting + retry + message truncation.**

- `ModelConcurrencyManager` — singleton with separate `thinkingQueue` and `standardQueue`
- `ConcurrencyQueue` — semaphore with priority-based queueing
- `retryWithBackoff(fn, options)` — exponential backoff with jitter
- `truncateToolMessagesInPayload(payload, opts)` — truncate tool outputs
- `checkRequestBodySize(bodyJson, maxBytes)` — 413 guard

### `src/cache.js` (93 lines)
**In-memory LRU prompt-response cache with TTL.**

- `cacheKey(req)` — hash of model + temperature + tool count + normalized messages
- `check(key)` / `store(key, value)` — cache operations
- `invalidate()` / `stats()` / `configure(opts)` — cache management

### `src/token-optimizer.js` (563 lines)
**Multi-level prompt compression (7 levels).**

- `compressContent()` / `compressMessages()` / `compressBest()` — compression functions
- `compressToolDefinitions(tools)` — compress tool schemas for upstream
- `compactIdentity(model)` — model identity prompts
- `CompressionLevel` enum: `off`, `lite`, `caveman`, `aggressive`, `ultra`, `rtk`, `stacked`

---

## Client Detection

Detected in priority order:

| Client | Detection | Tag | Key behaviors |
|--------|-----------|-----|---------------|
| **LocalPilot** | Content has `## [LP]`, `## TASK`, `</task_type>`, etc. | `lp` | Orphan tool messages dropped |
| **VS 2026** | UA matches `/OpenAI\/.*\.NET/i` | `vs` | Non-streaming upstream, markdown tool extraction, file creation workflow, simulated SSE |
| **VS Code** | UA matches `/githubcopilot/i` | `vscode` | Separators stripped from model lists, `[FREE]`/`[GO]`/`[M365]` prefixes in model names |
| **Unknown** | No system message, first is user; or content has `github copilot` | `vs` | No special handling |

---

## Model Tiers

| Tier | Source | Count | Auth | Endpoint |
|------|--------|-------|------|----------|
| **Free** | OpenCode Zen | 6 models | None | `https://opencode.ai/zen/v1/chat/completions` |
| **Pollinations** | text.pollinations.ai | 7 models (1 real + 6 cosplay) | None | `https://text.pollinations.ai/openai/chat/completions` |
| **Paid** | OpenCode Go | Dynamic | `Bearer {key}` | `https://opencode.ai/zen/go/v1/chat/completions` |
| **M365** | M365 Copilot via relay WS | 2 models (Quick/Think) | Browser session | `ws://127.0.0.1:{M365CO_PORT}` |

---

## M365 Copilot Integration

Uses a WebSocket relay at `ws://127.0.0.1:8765` to connect to M365 Copilot. See [g365-headless-relay](https://github.com/notBlubbll/g365-headless-relay) for the self-hostable relay server.

### Relay protocol

```
→ {"type":"new","model":"gpt-5.5-quick"}
← {"type":"ready","model":"gpt-5.5-quick"}
→ {"type":"chat","text":"..."}
← {"type":"delta","text":"resp"}
← {"type":"message","text":"full response"}
← {"type":"done"}
```

### Prompt folding

Messages folded into labeled plain text with `---` separator (matching [m365-copilot-openai-proxy](https://github.com/kuchris/m365-copilot-openai-proxy)).

### Response handling

- `type: "delta"` → SSE stream; `type: "message"` → authoritative full response (used if no deltas arrived)
- `[COPILOT]` prefix stripped; deltas after full message discarded

### Shared connection

- Persistent WebSocket, serialized via `_sendGate`, re-established on close/error
- Model changes send `{ type: "new" }` to create a fresh browser session

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tags` | Ollama model list (with separators, capabilities, context) |
| GET | `/api/list`, `/api/models` | Aliases for `/api/tags` |
| POST | `/api/show` | Model detail (Ollama format) |
| POST | `/api/chat` | Ollama chat API (NDJSON streaming) |
| POST | `/api/generate` | Ollama generate API (NDJSON streaming) |
| POST | `/v1/chat/completions` | Main chat endpoint — streaming, tool calling, compression, cache |
| POST | `/v1/engines/copilot-codex/completions` | Inline code completions |
| GET | `/v1/models` | OpenAI-format model list with capabilities |
| GET | `/api/stats` | Metrics: uptime, model counts, concurrency, cache size |
| POST | `/api/refresh` | Force refresh model list |
| POST | `/api/diagnostics` | Self-test with tool-calling roundtrip |
| GET | `/health` | Health check with model counts |
| GET | `/api/version` | Returns `{"version":"420.96.00"}` |
| GET | `/stop` | Graceful shutdown |

---

## Key Behaviors

- **Model registry**: Free models hardcoded, paid models fetched from Go API, metadata from models.dev. Cached to `.cache/models.json` disk.
- **Key validation**: On startup, pings `deepseek-v4-flash` with `max_tokens: 1` *before* fetching the paid model list. If inference fails (429), paid models are skipped entirely and `Premium+Free` mode isn't advertised. If `deepseek-v4-flash` returns 404, falls back to the first premium model from the API with a warning.
- **Rate-limit persistence**: 429 responses are parsed for `error.type` + `error.message` (e.g. `GoUsageLimitError: Weekly usage limit reached. Resets in 1 day.`). The timing is extracted from the message and persisted to `.cache/key-state.json`. On restart, cooldowns are respected — no ping or model fetch is performed while the key is still banned.
- **Key rotation**: Round-robin with cooldown. 401 → 60s cooldown, 429 → persisted ban duration. Validated via real inference pings. Hash persisted to `.cache/keyhash.json`.
- **Auto-compression**: `COMPRESSION_LEVEL=auto` selects `off` for ≤3 messages, `stacked` for free/poll, `caveman` for paid.
- **Auto-restart**: Exit code 42 triggers restart via `start.cmd` loop. Console commands: `r`/`restart`, `s`/`stop`, `e`/`exit`.
- **Graceful shutdown**: `/stop` endpoint or SIGINT/SIGTERM/SIGHUP with 30s timeout.
- **VS 2026 file creation**: Markdown code blocks parsed into `create_file` tool calls. Project files (`.csproj`, `.sln`) handled natively.
- **Pollinations**: 6 cosplay aliases hidden by default (`HIDE_POLL_COSPLAY=true`). Only `pol/openai-fast` (GPT-OSS 20B) shown. Controlled by `SHOW_POLL_MODELS` + `HIDE_POLL_COSPLAY`. URL hardcoded to `https://text.pollinations.ai/openai`.
- **Version check**: Compares local `.version` against remote GitHub raw file. Console title updates when outdated.
