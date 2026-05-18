# AGENTS.md

## gc2oc Proxy

Ollama-emulating proxy that connects **GitHub Copilot Chat & Agent** (VS 2026 / VS Code) to the [OpenCode](https://opencode.ai) Zen + Go APIs + free models. Exposes an Ollama-compatible HTTP API on `localhost:11434` so the GitHub Copilot extension's built-in Ollama provider can use OpenCode models.

**Runtime:** Bun (preferred) → Node.js fallback. Framework: Hono. Launcher: C# `service.exe` (dual-mode: console + Windows service, embedded in `build-node.cmd`).

---

## Architecture

```
VS 2026 / VS Code                    gc2oc Proxy                 Upstream APIs
─────────────────                    ──────────────────                  ─────────────
GitHub Copilot extension             src/server.js                       OpenCode Zen (free)
  │  Ollama provider                   │  Hono HTTP server                 │  https://opencode.ai/zen/v1
  │  → /api/tags                       │  → model registry                 │
  │  → /v1/chat/completions            │  → chat completion                │
  │  → /api/chat                       │  → compression                    │  OpenCode Go (paid)
  ▼                                    │  → caching                        │  https://opencode.ai/zen/go/v1
                                    ┌───┴──────────────┐                  │
                                    │ Client detection  │                  │  CrofAI (paid)
                                    │ ├─ isVS2026()     │                  │  https://crof.ai/v1
                                    │ ├─ isVSInsiders() │                  │
                                    │ ├─ isVSCode()     │                  │  Pollinations (free)
                                    │ ├─ isSqlStudio()  │                  │  https://text.pollinations.ai/openai
                                    │ └─ LocalPilot     │                  │
                                    └───┬──────────────┘                  │
                                        │                                  │  M365 Copilot (opt)
                                    ┌───┴──────────────┐                  │  ws://127.0.0.1:8765
                                    │ Model routing     │                  │  → substrate.office.com
                                    │ ├─ M365 → relay   │                  │
                                    │ ├─ Crof → crof.   │                  │
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
                                     └───┬──────────────┘                  │
                                         │                                  │
                                     ┌───┴──────────────┐                  │
                                     │ Session keepalive│                  │
                                     │ ├─ track session  │                  │
                                     │ ├─ KV cache ping  │                  │
                                     │ └─ idle cleanup   │                  │
                                     └──────────────────┘                  ▼
```

---

## Source Files

### `src/server.js` (~4250 lines)
**Main entry point.** HTTP routing, request orchestration, response formatting.

- `restartSelf(exitCode)` — spawn `cmd /c start` → new console → inner `cmd /c` runs the exe. Uses `process.execPath` (NOT `process.argv[0]` — in Bun-compiled binaries `argv[0]` is `"bun"`, not the exe path). Wrapped mode (`GC2OC_WRAPPED=1`): just `process.exit()`.
- `isVSCode(c)` / `isVS2026(c)` / `isVSInsiders(c)` / `isSqlStudio(c)` — client detection from `User-Agent` (VS Code) and `baggage` header (VS/VS Insiders/SQL Studio)
- `extractVSContext()` / `getWorkspaceRoot()` / `getActiveFile()` — extract workspace paths from VS context blocks
- `extractToolCalls()` — parse AI response text into tool calls (markdown blocks → `create_file`)
- `processThinkTags()` — `<think>` tag extraction for DeepSeek reasoning
- `_simStream()` — simulated SSE streaming from non-stream responses (VS 2026)
- `createReasoningContext(messages, model, workspace, clientTag, provider, thinking)` — per-request reasoning cache factory with conversation-scoped isolation (prevents cross-session poisoning)
- `_convId(messages, model, workspace)` — stable session identifier from hashed pre-assistant user messages + model + workspace
- `_startPrompt(messages)` — raw pre-assistant user message text for continuation matching
- `_msgHash(msg)` — content/tool-call hash for per-message reasoning lookup
- `_sessionRegistry` / `_sessionCounter` — global session tracking (Map of convId → { id, clientTag, createdAt }), assigns monotonic session numbers
- `normalizeOpenAIParams()` — camelCase → snake_case parameter mapping
- `sanitizeContent()` — strip `<|im_start|>`, `<|im_end|>` tokens
- `mapModel(name)` — resolve model names, strip `[FREE]`/`[GO]`/`[M365]`/`[CROF]` prefixes
- `_checkCrofRefresh()` — runtime Crof key state detector: when `CROF_API_KEY` is added/removed or the key is present but no Crof models exist in the registry, triggers an immediate model refresh so Crof models appear/disappear without restart. Called from `handleTags()` and `/v1/chat/completions`.
- **Banner rendering** — builds a Unicode box-drawing table (`┌─┐ │ ├─┤ └─┘`, 78 chars wide) with GH2OC block-letter logo, model registry, command hints, and thinking mode labels. Produces two variants:
  - **Collapsed** (`_bannerCollapsed`): logo + port + commands + category summaries (`▶ Free (3)`) + bottom border
  - **Expanded** (`_bannerLines`): full model table with `◀` section headers and per-model thinking mode initials
- **Thinking mode labels**: `L, M, H, XH` displayed after model names in white (`\x1b[37m`) with light-gray commas. Mapped via `getThinkingModes()` from `opencode-client.js`. Column widths: Name=38, ID=22, Context=7 (fits within 78-char box). Truncation is ANSI-aware (splits on escape codes before slicing) to handle names with thinking mode labels.
- **Build date display**: Port/status line shows `built YYYY-MM-DD` parsed from `.version` (Unix ms timestamp), replacing the hardcoded `vs2026` label.

### `src/opencode-client.js` (~1950 lines)
**Model registry + upstream API communication.**

- `config` — env-var-backed configuration getters
- `initModels()` — bootstrap model list (disk cache → fetch → background refresh)
- `getModels()` / `refreshModels()` / `validateFreeModels()` — model lifecycle
- `resolveModel(name)` / `resolveModelMetadata(modelId)` — model lookup with metadata inference
- `chatCompletion(req)` — **async generator** for SSE streaming from upstream
- `zenRequest(endpoint, body, opts)` — upstream HTTP with key rotation, retry, cooldown
- `isKnownModel()` / `isFreeTierModel()` / `isPollModel()` / `isSeparator()` / `isM365Model()` / `isCrofModel()` — model classifiers
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

### `src/crof-client.js` (50 lines)
**CrofAI API client — model list fetching + availability.**

- `isCrofAvailable()` / `getCrofApiKey()` — check if `CROF_API_KEY` is configured
- `getCrofModels()` — fetch model list from `https://crof.ai/v1/models` with auth. Returns models with `crof/` prefix in IDs to avoid conflicts with OpenCode Go models. Cached in memory.
- `clearCrofCache()` — invalidate model cache on refresh

### `src/concurrency.js` (312 lines)
**Concurrency limiting + retry + message truncation.**

- `ModelConcurrencyManager` — singleton with separate `thinkingQueue` and `standardQueue`
- `ConcurrencyQueue` — semaphore with priority-based queueing
- `retryWithBackoff(fn, options)` — exponential backoff with jitter
- `truncateToolMessagesInPayload(payload, opts)` — truncate tool outputs
- `checkRequestBodySize(bodyJson, maxBytes)` — 413 guard

### `src/session-keepalive.js`
**Session keepalive — periodically pings active upstream sessions to prevent KV cache eviction.** Inspired by [TaskSync #98](https://github.com/4regab/TaskSync/issues/98).

- `trackSession(sessionId, model, messages, clientTag)` — save compressed messages after each real request, schedule keepalive timer
- `touchSession(sessionId)` — reset idle timer on incoming request (keeps session alive across active usage)
- `doKeepalive(sessionId)` — send minimal upstream ping (`max_tokens:1`, `stream:false`, no tools) to keep KV cache warm. Stops after `SESSION_KEEPALIVE_IDLE_TIMEOUT_MS` of inactivity. Cycles (resets `createdAt` + resumes pinging) after `SESSION_KEEPALIVE_MAX_LIFETIME_MS` (24h) to re-establish upstream KV cache
- `shutdown()` — clean up all timers on graceful shutdown
- `stats()` — returns session count, total pings, config values

### `src/cache.js` (93 lines)
**In-memory LRU prompt-response cache with TTL.**

- `cacheKey(req, sessionId)` — hash of model + temperature + tool count + session discriminator + normalized messages
- `check(key)` / `store(key, value)` — cache operations
- `invalidate()` / `stats()` / `configure(opts)` — cache management

### `src/token-optimizer.js` (636 lines)
**Multi-level prompt compression (7 levels).**

- `compressContent()` / `compressMessages()` / `compressBest()` — compression functions
- `compressToolDefinitions(tools)` — compress tool schemas for upstream
- `compactIdentity(model)` — model identity prompts
- `_dropOldToolOutputs(messages, keepCount)` — drops old (assistant tool_call → tool result) pairs, keeping only the most recent N
- `CompressionLevel` enum: `off`, `lite`, `caveman`, `aggressive`, `ultra`, `rtk`, `stacked`

### `src/completion-cache.js`
**Reasoning cache + prompt-response cache integration.** Caches `<think>` tag text per message and re-attaches on cache hits so DeepSeek-style reasoning isn't lost.

### `src/logger.js` (354 lines)
**Console dashboard TUI with virtual scrollback buffer.**

- `enableDashboard(collapsedLines, expandedLines)` — enters raw-mode keyboard listener, paints banner + live log tail. No alternate screen buffer by default (starts expanded with native scrollbar visible). Mouse reporting is disabled so text selection with cursor works.
- `disableDashboard()` — exits raw mode, restores normal stdin.
- `log(msg)` / `warn(msg)` / `error(msg)` / `debug(msg)` / `reqLog({...})` — in dashboard mode, push to virtual buffer (`_buffer`) and repaint live tail (last 5 entries) in-place below the banner. Outside dashboard mode, write to stdout/stderr normally. `debug()` always writes to console but only stores in the virtual buffer when `DEBUG=1`/`true`/`yes` (so debug messages don't clutter the scrollable history when debug is off).
- **Banner variants**: `_bannerCollapsed` (GH2OC logo + port + commands + category count summaries + `└─┘`) and `_bannerExpanded` (full model table with `◀` section headers + `└─┘`). Switched via `_collapsed` flag.
- **Model collapse/expand**: `→` (right arrow) expands to full table, `←` (left arrow) collapses to category summaries. Auto-collapses on the first chat request of any handler via `collapseBanner()`, then starts a 3s idle timer. Each subsequent request resets the timer. When the timer fires (3s after last request), auto-expands. Manual toggle (`_userToggled`) overrides idle expand until the next request.
- **Virtual scroll buffer**: `_buffer` array holds all log entries. `_scrollOffset` tracks how far the user has scrolled up from live tail. `_scrollMode` flag enables the scroll overlay.
- **Live tail**: banner + last 5 log entries visible by default. Footer shows `─ live tail (N entries) ─ ↑↓ PgUp PgDn = scroll ─`. Commands line shows `d/debug  ←→ collapse  ↑↓PgUp/PgDn scroll`.
- **Scroll overlay**: `↑`/`↓` scroll 1 line, `PgUp`/`PgDn` scroll 5 lines. Shows page indicator (`─ page 3/10 ─ N entries ─ any key = live tail ─`). Any non-scroll key or typing exits scroll mode back to live tail. No auto-close timer.
- **Console commands** (raw mode): type `s`/`stop`, `r`/`restart`, `u`/`update`, `d`/`debug`, `c`/`clear` + Enter. Characters echo while typing. `Ctrl+C` = stop. Backspace works.
- **Debug toggle**: `d` + Enter toggles `DEBUG` on/off. When on, debug messages appear in the virtual scroll buffer; when off, they still print to the console but are excluded from the scrollback history. The commands line shows `d`/`debug` in green when enabled, cyan when disabled.
- **Redraw**: `\x1b[H\x1b[J` clears visible area and redraws banner + log tail. Banner always redraws from `_banner` array, log tail from `_buffer`. Alternate screen buffer hides native scrollbar; mouse reporting disabled for text selection.
- **Page calculation**: `page = Math.ceil((total - _scrollOffset) / VISIBLE_LINES)` — correctly maps scroll position to page number.

---

## Build System

### `build-node.cmd` (~520 lines)
**Node.js portable build + embedded C# launcher compiler.**

- Copies `src/`, `package.json`, `node` (without `.exe` — see below), `.env`, `.version` into `.dist/`
- Generates `.dist\start.cmd` — one-shot batch launcher calling `service.exe`
- Extracts embedded C# source from itself (after `goto :EOF`), compiles in-memory via PowerShell `Add-Type` → `.dist\service.exe` (no temp `.cs`/`.csproj` files)
- Falls back to `dotnet publish` → `csc.exe` if `Add-Type` unavailable

### `build-bun.cmd` (~450 lines)
**Bun standalone build + embedded C# service launcher compiler.**

- Compiles `src/server.js` → `.dist\gc2oc` (Bun standalone, ~112 MB, no `.exe` extension — prevents accidental double-click)
- Generates `.dist\start.cmd` — one-shot batch launcher: `@"%~dp0service.exe"`
- Extracts embedded C# source (after `===CS_START===` marker), compiles in-memory via PowerShell `Add-Type` → `.dist\service.exe`
- Falls back to `dotnet publish` (with `System.ServiceProcess.ServiceController` package) → `csc.exe`

### `service.exe` (C# launcher, compiled at build time)
**Dual-mode: interactive console + Windows service.** Source embedded in the respective `build-*.cmd` file, extracted at build time via PowerShell `Add-Type` with `System.Core.dll` + `System.ServiceProcess.dll`.

**Interactive mode** (double-click / CLI):
- Sets console title, loads `.env`, kills port, launches the server runtime
- Restart loop: exit 42 → restart, exit 43 → run `update.cmd` → restart
- **Stops any existing instance before starting:** tries `ServiceController.Stop()` (derived name + `gc2oc` fallback, 30s timeout), kills other process with same exe name, retries port cleanup 4×1s
- Node build: checks bundled `node` (no extension) if system `node` not in PATH
- Bun build: launches `gc2oc` (no extension, no fallbacks — only looks in the same directory)

**Service mode** (checks `Environment.UserInteractive`):
- Uses `ServiceBase.Run(new Gc2ocService())` with `AutoLog = true`
- `OnStart`: launches server in background thread (same restart/update loop as console, no console output)
- `OnStop`: sets global `stopping` flag, kills server process, joins thread (15s)

**Dynamic naming** — service name + console title derived from (in order):
1. `GC2OC_SERVICE_NAME` env var
2. EXE filename without extension (e.g. `service.exe` → `service`)
3. Fallback `"gc2oc"`

### `node` / `gc2oc` (no extension)
**Runtime binary with no `.exe`** in `.dist/`. Prevents accidental double-click launch (Bun standalone is 112 MB), but the C# `service.exe` and `start.cmd` find them via `Path.Combine(baseDir, "gc2oc")` / `Path.Combine(baseDir, "node")`. For the Node build, system `node` (with `.exe`) is still found first if in PATH.

### Build scripts
| Script | Purpose | Output |
|--------|---------|--------|
| `build.cmd` | Auto-detect Bun vs Node, delegate | — |
| `build-bun.cmd` | Bun standalone + C# launcher | `gc2oc` + `service.exe` + `start.cmd` |
| `build-node.cmd` | Portable folder + C# launcher | `node` + `src/` + `service.exe` + `start.cmd` |
| `start.cmd` | One-shot batch launcher (dev) | — |
| `update.cmd` | Self-updater | — |
| `update-and-build.cmd` | Update + Build combined | — |

---

## Client Detection

Detected in priority order:

| Client | Detection | Tag | Key behaviors |
|--------|-----------|-----|---------------|
| **LocalPilot** | Content has `## [LP]`, `## TASK`, `</task_type>`, etc. | `lp` | Orphan tool messages dropped |
| **SQL Studio** | `baggage` contains `SSMSAgent` | `sql` | No special handling |
| **VS Insiders** | `baggage` contains `VirtualAgentModeResponder` | `vsi` | Non-streaming upstream, markdown tool extraction, file creation workflow, simulated SSE |
| **VS 2026** | `baggage` contains `vs.copilot.` (not `VirtualAgentModeResponder`) | `vs` | Non-streaming upstream, markdown tool extraction, file creation workflow, simulated SSE |
| **VS Code** | UA matches `/GitHubCopilotChat\//i` | `vscode` | Separators stripped from model lists, `[FREE]`/`[GO]`/`[M365]`/`[CROF]` prefixes in model names |

---

## Model Tiers

| Tier | Source | Count | Auth | Endpoint |
|------|--------|-------|------|----------|
| **Free** | OpenCode Zen | 4 models | None | `https://opencode.ai/zen/v1/chat/completions` |
| **Freemium** | OpenCode Zen (key req.) | Same 4 free models, but with API key | `Bearer {key}` | `https://opencode.ai/zen/v1/chat/completions` |
| **Pollinations** | text.pollinations.ai | 7 models (1 real + 6 cosplay) | None | `https://text.pollinations.ai/openai/chat/completions` |
| **Paid** | OpenCode Go | Dynamic | `Bearer {key}` | `https://opencode.ai/zen/go/v1/chat/completions` |
| **Crof** | CrofAI | Dynamic | `Bearer {key}` | `https://crof.ai/v1/chat/completions` |
| **M365** | M365 Copilot via relay WS | 2 models (Quick/Think) | Browser session | `ws://127.0.0.1:{M365CO_PORT}` |

> **Freemium detection**: On startup and each model refresh, free models are pinged against the Zen free endpoint. Models that require a key (return 401 without auth) are retried with the API key. If they respond successfully, they are marked as **freemium** — displayed in orange in the model list and routed to the Zen free endpoint with `Bearer` auth.

---

## Free Model Discovery

Free models are sourced from the **OpenCode Zen** free tier (`https://opencode.ai/zen/v1`). They are hardcoded in `FREE_TIER_MODELS` (`src/opencode-client.js:37`) because the Zen API does not expose a model list endpoint.

### How to discover new free models

1. Fetch `https://models.dev/api.json`
2. Filter by provider **`opencode`**
3. Filter by `cost.input === 0 && cost.output === 0`
4. **Ping each candidate** against `https://opencode.ai/zen/v1/chat/completions` (no auth) — many models.dev entries are catalog-only and return `ModelError: not supported`
5. Only add IDs that return HTTP 200

### Current free models (4)

| Model ID | Name | Tools | Vision | Context |
|----------|------|-------|--------|---------|
| `big-pickle` | Big Pickle | ✓ | ✓ | fallback |
| `minimax-m2.5-free` | MiniMax M2.5 Free | ✓ | ✓ | fallback |
| `nemotron-3-super-free` | Nemotron 3 Super Free | ✓ | ✓ | fallback |
| `ring-2.6-1t-free` | Ring 2.6 1T Free | ✓ | ✗ | 262000 |

> **Important:** models.dev lists ~16 `opencode` models with `cost: 0`, but only 4 respond on the Zen API. The rest return `ModelError: not supported`. Always verify with a live ping before adding.

### Freemium (free models with API key)

When an `OPENCODE_API_KEY` or `OPENCODE_API_KEYS` environment variable is configured, free Zen models are validated via ping: first without a key, then retried with the API key on 401. Models that respond successfully with the key are marked as **freemium** — displayed in orange in the model list banner and still routed to the free Zen endpoint (`https://opencode.ai/zen/v1/chat/completions`), but now send the API key as a `Bearer` token. This allows access to free models even when the OpenCode terms require a key to be on file. Internally, the `_freemium: true` flag is set on model entries and `isFreemiumModel()` checks `_modelMap` at request time.

### HIDE_FREE

Set `HIDE_FREE=true` (default `false`) to hide all free tier models and separators from the model list. Useful when you only want premium models visible.

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
- **Rate-limit persistence**: 429 responses are parsed for `error.type` + `error.message` (e.g. `GoUsageLimitError: Weekly usage limit reached. Resets in 1 day.`). The timing is extracted from the message and persisted to `.cache/key-state.json`. On restart, cooldowns are respected — no ping or model fetch is performed while the key is still in cooldown.
- **Key rotation**: Round-robin with cooldown. 401 → 7-day persisted cooldown (via `key-state.json`), 429 → persisted cooldown duration. Validated via real inference pings. Hash persisted to `.cache/keyhash.json`.
- **Auto-compression**: `COMPRESSION_LEVEL=auto` selects `off` for ≤3 messages, `stacked` for free/poll, `caveman` for paid/crof.
- **Tool output dropping**: Old (assistant tool_call → tool result) pairs are dropped at all compression levels above `off`. Groups are dropped atomically (all tool results from the same assistant are kept or dropped together) to prevent orphaned `tool` messages. Kept count per level: `lite`=8, `caveman`/`rtk`=6, `stacked`=4, `aggressive`=3, `ultra`=1. Override with `TOOL_OUTPUT_KEEP_COUNT=N`.
- **Auto-restart**: Exit code 42 triggers restart, exit 43 triggers update-then-restart. The restart loop lives in `service.exe` (C# launcher). Console commands: `s`/`stop`, `r`/`restart`, `u`/`update`, `d`/`debug`, `c`/`clear` (type + Enter in dashboard raw mode). Characters echo while typing. `Ctrl+C` = stop.
- **Console dashboard**: On startup, displays a Unicode box-drawing table with GH2OC block-letter logo, model registry, thinking mode labels, and command hints. Uses alternate screen buffer (hides native scrollbar) but no mouse reporting (text selection with cursor works). All `log()`/`warn()`/`error()`/`reqLog()` output is captured to a virtual scrollback buffer. Last 5 entries shown as "live tail" below the banner. Arrow keys (`↑`/`↓`/`PgUp`/`PgDn`) browse the full buffer via scroll overlay with page numbers. Any non-scroll key or typing exits scroll mode back to live tail.
- **Debug toggle**: `d` + Enter toggles `DEBUG` on/off. When on, debug messages appear in the virtual scroll buffer; when off, they still print to the console but are excluded from the scrollback history.
- **Model table collapse**: `→` (right arrow) expands to full table, `←` (left arrow) collapses to category summaries. When collapsed (`▶ Free (3)`), enters alternate screen buffer (`\x1b[?1049h`) to hide native scrollbar since the small banner + log tail fits in view. When expanded (full model table), exits ASB (`\x1b[?1049l`) so the native scrollbar is available — enables scrolling through the full table content. Auto-collapses on the first chat request of any handler via `collapseBanner()`, then starts a 3s idle timer. Each subsequent request resets the timer. When the timer fires (3s after last request), auto-expands. Manual toggle (`_userToggled`) overrides idle expand until the next request.
  - **Wrapped mode** (`GC2OC_WRAPPED=1` set by `service.exe`): `restartSelf()` calls `process.exit(42)`, the C# launcher catches exit code 42 and re-launches `gc2oc`/`node`.
  - **Standalone mode** (compiled `.exe` run directly, no wrapper): `restartSelf()` spawns `cmd /c start /D <wd> cmd /c <exe>` — opens a new independent console window. The inner `cmd /c` runs the exe. A 500ms delay before exit gives `start` time to create the new process.
  - **Bun binary caveat**: In Bun-compiled `.exe` binaries, `process.argv[0]` returns `"bun"`, NOT the exe path. Always use `process.execPath` for the exe path. Bun also kills all child processes on `process.exit()`, so spawning-based restart is fragile — the `cmd /c start` approach works because `start` creates the new console window before Bun exits.
- **Graceful shutdown**: `/stop` endpoint or SIGINT/SIGTERM/SIGHUP with 30s timeout.
- **VS 2026 file creation**: Markdown code blocks parsed into `create_file` tool calls. Project files (`.csproj`, `.sln`) handled natively.
- **Single-pass file edits**: When editing files, plan all changes first, then apply them in one edit operation. VS receives multiple `create_file` tool calls as separate edits — batching related changes into a single edit reduces round-trips and prevents VS from seeing fragmented partial changes.
- **Tool call normalization**: `normalizeToolCall()` in `src/server.js:419` sanitizes AI-generated tool call arguments before returning to VS. VS schemas differ from standard Copilot — always verify against actual `body.tools` schemas if tools fail.
  - **`get_file` schema (VS Insiders 18.7)**: `required: ["filename","startLine","endLine"]`, `additionalProperties: false`. Properties: `filename` (string), `startLine` (integer, 1-based), `endLine` (integer, 1-based, inclusive), `includeLineNumbers` (boolean, default false). Note: VS uses `filename` not `filePath`.
  - **`grep_search` schema (VS Insiders 18.7)**: `required: ["query","isRegexp","includePattern","maxResults"]`, `additionalProperties: false`. Properties: `query` (string, case-insensitive), `isRegexp` (boolean), `includePattern` (string|null, glob pattern), `maxResults` (integer|null, max 200, default 20). Note: VS uses `query` not `pattern`, `includePattern` not `fileTypes`, and `isRegexp` + `maxResults` are required.
  - **`find_symbol` schema (VS Insiders 18.7)**: `required: ["navigationType","filepath","symbolName","lineText"]`, `additionalProperties: false`. Properties: `navigationType` (integer — 0=goToDefinition, 1=findReferences), `filepath` (string), `symbolName` (string), `lineText` (string, can be empty `""`). Note: `navigationType` is an **integer**, NOT a string — the proxy must preserve the number type from the AI, not coerce to `String()`.
  - **`lookup_vs` schema (VS 2026)**: `required: ["terms"]`, properties: `terms` (string[]). Performs VS help/documentation lookups (MSDN, .NET API ref, NuGet docs). Proxy normalizes `query`/`search`/`queries` aliases to `terms` and coerces single strings to arrays.
  - **`_simStream()` tool call format**: `_simStream()` in `src/server.js:363` sends tool calls in a **single SSE delta** with both `name` and `arguments` together (e.g. `{function: {name: "create_file", arguments: "..."}}`). Do NOT split into two deltas (name+empty-args then args) — VS processes only the first delta and sees empty arguments, causing `"missing parameter filePath"`.
  - **DeepSeek truncated JSON**: DeepSeek models frequently generate `create_file` tool calls with `content` truncated mid-string (e.g. `"content": "markdown...` without closing quote). This produces an `Unterminated string in JSON` error when `normalizeToolCall()` tries `JSON.parse()`. The fix in `src/server.js:839` (catch block): when `JSON.parse` fails on `create_file`, **regex-salvage** `filePath` and `content` from the malformed JSON string using `/\"filePath\"\s*:\s*\"((?:[^\"\\]|\\.)*)\"/` and `/\"content\"\s*:\s*\"((?:[^\"\\]|\\.)*)/`, then reconstruct valid JSON via `JSON.stringify()`.
  - **`normalizeToolCall` catch block scope**: Variables declared with `const`/`let` in the try block are NOT visible in the catch block (block scoping). Do not reference `raw` or `args` in the catch — use `tc.function.arguments` directly instead.
- **Pollinations**: 6 cosplay aliases hidden by default (`HIDE_POLL_COSPLAY=true`). Only `pol/openai-fast` (GPT-OSS 20B) shown. Controlled by `SHOW_POLL_MODELS` + `HIDE_POLL_COSPLAY`. URL hardcoded to `https://text.pollinations.ai/openai`.
- **Version check**: Compares local `.version` against remote GitHub raw file. Console title updates when outdated.

---

## Key Cooldown Checker

On startup and model refresh (`refreshModels` → `fetchGoModelsRaw`), the proxy loads `.cache/key-state.json` and restores active cooldowns. This prevents a rate-limited key from being pinged on restart.

### Restore flow

1. **`loadKeys()`** (`src/opencode-client.js:307`) — parses keys from env, creates/re-creates `ApiBalancer`, loads `key-state.json` via `loadKeyState()`.
2. **`ApiBalancer._restoreState()`** (`src/opencode-client.js:327`) — maps saved `short` key fragments back to full key strings from current env. Sets `cooldownUntil` on any non-expired cooldown. Logs: `[keys] restored N cooldown(s) from cache`.
3. **Direct disk safety net** (`fetchGoModelsRaw` `src/opencode-client.js:917`) — as a second check, reads `key-state.json` directly and builds a `cooldownFromDisk` Map from the local `keys` array. The `keyInCooldown()` helper checks both `_balancer.cooldownUntil` (in-memory) AND `cooldownFromDisk` (direct file read).

### Cooldown checks

- **All-key cooldown** (`src/opencode-client.js:946`): if every key is in cooldown, `fetchGoModelsRaw` skips the entire paid model fetch and returns `null` — `_paidGoData` stays null, paid models hidden.
- **Individual key cooldown** (`src/opencode-client.js:960`): before pinging each key, `keyInCooldown(k)` is checked. Keys in cooldown log `[keys] key[N] in cooldown — skipping` and are never contacted.
- **`withKey()` cooldown** (`src/opencode-client.js:444`): at request time, `_balancer.getNextKey()` skips keys in cooldown (via `_refillPool()` at line 353), so user requests never use a key in cooldown.

### Cooldown lifecycle

| Event | Action |
|-------|--------|
| 401 response | `ApiBalancer.mark401()` → sets 1h `cooldownUntil` (override via `OPENCODE_401_COOLDOWN_MS`), persists to disk |
| 429 response | `ApiBalancer.mark429()` → increments `consecutive429`, sets `cooldownUntil` if threshold met or upstream timer provided |
| Successful request | `ApiBalancer.markSuccess()` → clears `cooldownUntil`, resets `consecutive429` to 0 |
| State save | `saveKeyState()` → writes all cooldowns + counters to `.cache/key-state.json` |
| State load | `loadKeyState()` + `_restoreState()` + direct disk safety net |

### Key state file format

```json
{
  "keys": {
    "sk-abc1...xyz9": {
      "consecutive429": 3,
      "cooldownUntil": "2026-05-09T18:00:00.000Z",
      "cooldownReason": "429"
    }
  },
  "updatedAt": "2026-05-09T13:00:00.000Z"
}
```

Cooldown reason is `"401"` (auth denied, 7-day cooldown) or `"429"` (rate limited, duration varies).

---

## Session Keepalive (KV Cache Warming)

Keeps upstream LLM provider KV caches warm between consecutive turns by sending lightweight background pings. Inspired by [TaskSync #98](https://github.com/4regab/TaskSync/issues/98) — without session warming, each new prompt rebuilds the entire conversation prefix at full input token pricing. With warming, the cached prefix serves at ~10x cheaper cache-read pricing.

### How it works

1. After each real request completes, gc2oc saves the **compressed message list** (the conversation prefix) per session
2. After `SESSION_KEEPALIVE_INTERVAL_MS` (default 2min) of inactivity, a background **ping** is sent to the upstream API:
   - Same conversation prefix (messages) → KV cache hit
   - `max_tokens: 1` → negligible output cost
   - `stream: false`, no tools → minimal overhead
3. After `SESSION_KEEPALIVE_IDLE_TIMEOUT_MS` (default 10min) of total inactivity, pinging stops and the session is cleaned up
4. After `SESSION_KEEPALIVE_MAX_LIFETIME_MS` (default 24h) from session creation, the keepalive **cycles**: resets its clock and continues pinging. This ensures the upstream KV cache (which has a ~24h TTL) is re-established rather than pointlessly pinged
5. Incoming real requests **reset** the idle timer — active sessions stay warm automatically

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `SESSION_KEEPALIVE_ENABLED` | `true` | Enable/disable session keepalive |
| `SESSION_KEEPALIVE_INTERVAL_MS` | `120000` | Milliseconds between pings (min 30000) |
| `SESSION_KEEPALIVE_IDLE_TIMEOUT_MS` | `600000` | Milliseconds of inactivity before stopping (min 2x interval) |
| `SESSION_KEEPALIVE_MAX_LIFETIME_MS` | `86400000` | Maximum session lifetime before cycling upstream cache (default 24h, min 1h) |

### Exclusions

- **M365 sessions** are excluded (WebSocket-based, not HTTP prefix-cacheable)
- **Empty message lists** are excluded (no prefix to cache)

### Cost impact (from TaskSync #98)

| Scenario | Input token cost |
|----------|-----------------|
| Without warming | Full input price on every turn (~$5.00 for 25K tokens × N turns) |
| With warming | ~10x cheaper cache reads on turns 2+ (~$0.50 per turn after the first) |

A 40-minute agentic session with warming can cost **8x less** than a 5-minute session without.

---

## TPS Tracker (Console Title)

Tracks tokens-per-second throughput from upstream streaming responses and displays a rolling average in the console window title.

### How it works

1. After each streaming or non-streaming response completes, the elapsed time and token/chunk count are recorded
2. A rolling window (5 measurements) smooths the TPS value
3. The console title is updated (throttled to every 2s) with the format: `gc2oc [42.5 t/s]`
4. The version check title (`gc2oc (outdated, ...)`) is preserved — TPS is appended after it

### Title format

| State | Title |
|-------|-------|
| No activity yet | `gc2oc` |
| After requests | `gc2oc [42.5 t/s]` |
| Outdated + requests | `gc2oc (outdated, check github for new version) [42.5 t/s]` |
| Disabled | `gc2oc` |

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `SHOW_TPS` | `true` | Show TPS in console title. Set to `false` to disable. |

### Implementation

- `_recordTps(tokens, durationMs)` — called after each streaming/non-streaming response in `src/server.js`
- `_updateConsoleTitle()` — builds title from `_baseTitle` + `[X.X t/s]`, sets via `process.title` (primary) and ANSI escape (fallback)
- `setConsoleTitle(title)` — stores base title, triggers `_updateConsoleTitle()` so TPS suffix is always appended
- Hooks: `/v1/chat/completions` (streaming + non-streaming paths), `/api/chat`, `/api/generate`

---

## Caching Architecture

### Disk caches (`.cache/` dir)

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `models.json` | `saveModelsToDisk()` | `loadModelsFromDisk()` + `initModels()` | Full model list (free + paid + poll + M365) |
| `key-state.json` | `saveKeyState()` | `loadKeyState()` + `ApiBalancer._restoreState()` + `fetchGoModelsRaw` safety net | Per-key cooldown timestamps + 429 counters |
| `keyhash.json` | `saveKeyHashToDisk()` | `loadKeyHashFromDisk()` + `checkKeyChanged()` | SHA256 hash of all API keys for change detection |

### Disk cache invalidation

- **Key hash mismatch** → full model refresh (keys added/removed/rotated)
- **Free tier hash mismatch** → `FREE_TIER_MODELS` changed in code (new models added upstream)
- **M365 presence mismatch** → `M365CO_PORT` set or removed vs cached state
- **Crof key presence mismatch** → `CROF_API_KEY` set or removed vs cached state

### In-memory caches

| Cache | Module | Type | Key |
|-------|--------|------|-----|
| Prompt-response | `src/cache.js` | LRU with TTL | Hash of model + temperature + tool count + session discriminator + normalized messages |
| Reasonings | `src/server.js` `createReasoningContext()` | Per-session Map + per-request FIFO | Conversation-scoped: `convId:contentHash`; per-request position-based fallback |
| Free models | `src/opencode-client.js` `FREE_TIER_MODELS` | Static array | Hardcoded — validated via ping on startup |
| HIDE_FREE | `Bun.env.HIDE_FREE` | Env var | `false` — hide free tier + separators, show only premium models |
| Paid models | `src/opencode-client.js` `_paidGoData` | Module var | Fetched from `/zen/go/v1/models` |
| Crof models | `src/crof-client.js` `_cachedModels` | Module var | Fetched from `https://crof.ai/v1/models` |

### Startup sequence (caching)

```
initModels()
  ├─ _loadFs() — import node:fs for disk I/O
  ├─ _loadCrypto() — import node:crypto for SHA256 hashing
  ├─ checkKeyChanged() — compare current key hash to keyhash.json
  │   └─ loadKeyHashFromDisk() — read .cache/keyhash.json
  ├─ loadModelsFromDisk() — attempt to load .cache/models.json
  │   ├─ Validates key hash match (no rotation)
  │   ├─ Validates free tier SHA256 match (no code changes)
  │   ├─ Validates M365 token presence match
  │   └─ Validates Crof key presence match (CROF_API_KEY set vs cached state)
  │   → If valid: instant startup, background refresh via _bgFetch
  │   → If invalid: sync fetch from upstream, save to disk
  └─ _bgFetch = fetchGoModelsRaw() — background paid model validation
      ├─ loadKeys() → creates ApiBalancer → loads key-state.json
      ├─ Build cooldownFromDisk Map (direct safety net)
      └─ Per-key ping (skipping keys in cooldown)
```

---

## Session Tracking & Isolation

Distinct conversation contexts are detected and numbered. Each session gets a monotonic ID, and all cache keys are scoped by session to prevent cross-session data poisoning between concurrent users.

### Session detection

A session is identified by a **conversation ID** (convId) — a djb2 hash of:
1. **All user messages before the first assistant/tool message** — this captures the VS context block + the user's actual first query, differentiating between different chat tabs even in the same workspace
2. **Workspace root path** — same query in a different project is a different session
3. **Model name** — switching models creates a new session

```javascript
function _convId(messages, model, workspace) {
  // Hash ALL pre-assistant user messages (NOT just the first)
  // VS sends context block + user query as separate user messages
  const preAssistant = [];
  for (const m of messages) {
    if (role === "assistant" || role === "tool") break;
    if (role === "user") preAssistant.push(content);
  }
  return hash(preAssistant.join("\n") + "|" + workspace + "|" + model);
}
```

The convId is **stable across turns** in the same conversation (the pre-assistant prefix never changes), but **different across chat tabs** (the user's first query differs).

### Workspace continuation

Sessions in the same workspace+model can **continue** (reuse the previous session number) instead of incrementing. Continuation requires all three conditions to match:
1. Same workspace root
2. Same model
3. **Same start prompt** (pre-assistant user message text)

This prevents sessions from different chat tabs with different start prompts from leaking into each other, even when they share a workspace. The start prompt is stored in `_workspaceSessions` alongside the convId and session ID.

### Session registry

| Variable | Type | Purpose |
|----------|------|---------|
| `_sessionRegistry` | `Map<convId, {id, clientTag, createdAt}>` | Maps convId to session metadata |
| `_sessionCounter` | `number` | Monotonic counter, incremented per new session |
| `_workspaceSessions` | `Map<"workspace\|model", {convId, sessionId, startPrompt}>` | Tracks most recent session per workspace+model for continuation |

### Console output

**New session:**
```
new session 3 (vscode, go/deepseek-v4-flash, c:\workspace\project)
```

**Every request (new or existing):**
```
[vscode][3]>[go/deepseek-v4-flash]
[vscode][3] stream done (42 chunks)
[vscode][3] [TOOLS-TO-VS] create_file(...) | grep_search(...)
```

Format: `[clientTag][sessionId]>[provider/model]` for request headers, `[clientTag][sessionId]` prefix for internal log lines.

### Reasoning cache scoping

The reasoning cache (`_crossReqReasoningCache`) is a global Map keyed by `c:{convId}:{contentHash}`. Two different sessions with the same assistant message content (e.g. both say "Ok, I'll do that") will never collide because the convId segment differs.

The per-request FIFO (`_assistantReasonings` / cursor) is created fresh in `createReasoningContext()` — concurrent requests can never read each other's reasonings.

### Prompt-response cache scoping

`cacheKey(req, sessionId)` in `src/cache.js` includes the session discriminator (`convId`) in the cache key. Two different sessions with identical full message histories (vanishingly unlikely) are still isolated.

---

## Anti-Loop Guards

VS Copilot's agent mode can trigger infinite loops when the LLM's response doesn't satisfy VS's expectations. The following guards prevent common loop patterns:

### Bun.serve `maxRequestBodySize` — DO NOT USE

`Bun.serve({ maxRequestBodySize: N })` on Bun 1.3.13 (Windows) closes the TCP connection prematurely when a body exceeds the limit, instead of reading it and returning 413. VS's .NET `HttpClient` interprets the RST as `SocketError` → `"An established connection was aborted by the software in your host machine"` → retries 4x and fails. **Use the default (no `maxRequestBodySize`) and rely on the application-level `checkRequestBodySize()` guard instead.**

### Compression — disabled on localhost

`app.use(compress())` from Hono buffers SSE streaming responses. On localhost there is no bandwidth savings, and the buffering can cause .NET's `HttpClient` to timeout on stream reads.

### Tool retry loop false positives (`server.js:2217`)

The tool-failure detector uses a regex to check if tool results contain error words. **Must only match at the START** of content (`/^Error|^Failed|...`), NOT anywhere (`/error|fail|...`). grep/file results often contain code with words like `error`, `fail`, `timeout` in variable names/comments — matching anywhere falsely flags successful tool executions as failures. After 3 false positives, `toolLoopBroken = true` drops all subsequent tool calls/results, creating an infinite regeneration loop.

### Orphaned tool calls — strip, don't inject

`_stripOrphanedToolCalls()` MUST strip orphaned `tool_calls` from assistant messages rather than injecting fake tool results. Injecting `"[gc2oc] fake result for grep_search (original tool result missing from VS)"` confuses the LLM (wastes API calls) and breaks VS's agent loop. Stripping keeps the conversation clean without fake data.

### DeepSeek think-fallback (`server.js:2722`)

DeepSeek models with thinking mode (e.g. `deepseek-v4-flash`) may put all output inside `<think>` tags, leaving `cleanText` empty after `processThinkTags()`. Sending empty text to VS causes VS to nag/loop. **Fallback: use the first line of reasoning content as `cleanText`** (`[think-fallback]`).

### VS autopilot "continue" replacement (`server.js:2310`, `3024`)

VS agent mode sends bare `"continue"` as a user message when the user clicks continue. Stripping it leaves the LLM with no instruction → "what should I do?". **Replace it** with `"Continue with your current task using the tools available."` so the LLM proceeds with the task.

### VS nag loop with active tools (`server.js:2398`)

VS nags with `"You have not yet marked the task as complete"` even when the LLM is actively producing useful tool calls. The nag detector (`vsTaskCompleteNags >= 3`) should only escalate to `taskCompleteOnly` when the **last assistant message has NO tool_calls**. If the LLM is still working (has tool calls), only filter the nag messages but let the LLM continue. This prevents premature termination of productive sessions.

### Rate-limit session gate (`server.js`)

When a free-tier model returns HTTP 429, VS enters an aggressive retry loop that sends parallel requests and nags. Previous attempts to inject `task_complete` or return empty assistant messages created self-reinforcing loops (the injected response triggered more nags).

**Solution**: Once a session hits a 429, mark it in `_rateLimitedSessions` (convId → `{ at: timestamp }`). For **30 seconds**, any further request for that conversation returns a hard **HTTP 429** with an OpenAI-compatible error body:

```json
{
  "error": {
    "message": "Rate limit exceeded for this session.",
    "type": "invalid_request_error",
    "code": "rate_limit_exceeded"
  }
}
```

This applies to:
- The **early gate** (catches retries before upstream is called)
- The **nag loop-break** (catches VS nags after the first 429)
- The **stream catch** (returns an SSE error event)
- The **outer catch** (after zenRequest retries are exhausted)
- The **RateLimitError** path (concurrency manager rejection)

VS receives a proper error status and stops retrying instead of spiraling into nags. The 30s window is long enough to absorb VS's burst and short enough that the user can retry manually once the upstream cooldown expires.

### `maxRequestBodyBytes` default: 32MB

VS sends large workspace context blocks (often 16MB+). The default `maxRequestBodyBytes` in `concurrency.js` is raised from 10MB to 32MB (`33554432`) to avoid false 413 rejections.
