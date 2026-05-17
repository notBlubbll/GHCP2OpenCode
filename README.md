# gc2oc — GitHub Copilot to [OpenCode]

Ollama-emulating proxy that connects **GitHub Copilot Chat&Agent** to the [OpenCode](https://opencode.ai) Zen + Go APIs + models.

**No key needed** — free models work immediately. Add an API key in `.env` to unlock paid models *and* enable **freemium** mode (free models with API key auth). Full tool calling and streaming.

---

## Screenshots

**Console** — model table, context lengths, key status, commands:

<table><tr>
<td><img alt="Console free mode" src="https://github.com/user-attachments/assets/534e36a9-9028-42a7-b1a4-ac8a0ff6a128"></td>
<td><img alt="Console paid mode" src="https://github.com/user-attachments/assets/dbb734c3-0f2e-4d9b-84b8-f11a2fc6fb1e"></td>
</tr></table>

**Agent mode** — tool calling with free and paid models:

<p align="center"><img alt="Free model agent mode" src="https://github.com/user-attachments/assets/eb27e58e-0b64-4634-a50b-ae4cf2a8dd77"></p>

<p align="center"><img alt="Paid model agent mode" src="https://github.com/user-attachments/assets/72e41978-1da3-42d5-8ad3-73a84d88254f"></p>

---

## Requirements

| What | Why |
|------|-----|
| [Bun](https://bun.sh) or [Node.js](https://nodejs.org) | Runtime (Bun preferred, Node as fallback) |
| Visual Studio 2026 **(18.6.0+ incl. Insiders)** | Ollama provider (18.6.0+) |

---

## Supported Platforms

| Client | Status |
|--------|--------|
| VS 2026 (18.6.0+) | ✓ Supported |
| VS 2026 Insiders | ✓ Supported (features may be in flux) |
| VS 2026 (LocalPilot) | ⚠ Unsupported but working |
| VS Code | ⚠ Supported, not fully tested |
| SQL Studio (22.6.0+) | ✓ Supported |

> **VS 2026**: Ollama provider available in Visual Studio 2026 18.6.0 and later (regular + Insiders). Insiders features may be in flux due to its preview nature — expect occasional regressions.
>
> **VS Code**: Works via the GitHub Copilot extension's Ollama provider, but has not been thoroughly tested. Tool calling and streaming may have edge cases.
>
> **SQL Studio**: Ollama provider available in SQL Server Management Studio 22.6.0 and later.

---

## Quick Start

### 1. Run

```bash
start.cmd          # Windows
bun run start      # Bun (preferred)
npm run node       # Node.js fallback
```

### 2. Add to Visual Studio

**Requires Visual Studio 2026 18.6.0+ (regular or Insiders).**

1. Open the Copilot Chat panel
2. Click the model dropdown (next to the agent selector) → **Manage Models**
3. Click **Select Provider** → **Ollama**
4. Leave the endpoint at `http://localhost:11434` (unless your port differs)
5. Click **Add** — VS fetches models and validates them automatically:

<table><tr>
<td><img width="634" height="752" alt="paid" src="https://github.com/user-attachments/assets/d5810075-3f1f-4326-a6c8-89b2b0fed482"></td>
<td><img width="631" height="757" alt="free" src="https://github.com/user-attachments/assets/32b0be79-4664-441f-8bc4-3b154218964f"></td>
</tr></table>

You can now select any model from the dropdown. No model IDs to configure — the proxy resolves display names to the correct API IDs.

### 3. Add to VS Code

1. Install GitHub Copilot extension
2. Open Copilot Chat → model dropdown → **Manage Models**
3. Click **Select Provider** → **Ollama**
4. Enter `http://localhost:11434` as the endpoint
5. Click **Add** — models appear with `[FREE]` / `[GO]` prefixes:

| Prefix | Meaning |
|--------|---------|
| `[FREE]` | Free tier — always available, no key needed |
| `[FREE*]` | Freemium — free model, requires API key (orange in console) |
| `[GO]` | Premium — requires `OPENCODE_API_KEY` in `.env` |
| `[M365]` | Microsoft 365 Copilot — requires `M365C_TOKEN_PATH` in `.env` |


in VSCode:
<img width="1392" height="525" alt="image" src="https://github.com/user-attachments/assets/bc6a2a58-776b-4d2e-8fd8-bcf5f15b7bfa" />


### 3. (Optional) Unlock paid & freemium models

```env
# .env
OPENCODE_API_KEY=your-go-key
OPENCODE_API_KEYS=["key1","key2"]  # multi-key rotation
```

Adding an API key enables **freemium** mode — the Zen free models are also available with API key authentication (shown in orange in the console). Paid models are fetched dynamically and support full tool calling.

**Startup key validation**: On launch, the proxy pings `deepseek-v4-flash` with `max_tokens: 1` to verify the key can run inference. If it returns 429, the key is marked as rate-limited (with timing extracted from the error message, e.g. `Resets in 1 day`) and paid models are hidden from the list — avoiding wasted API calls on an unusable key. If `deepseek-v4-flash` returns 404, it falls back to the first premium model in the API response. Cooldown state is persisted to `.cache/key-state.json` and respected on restart.

### Key Rotation & Rate Limit Protection

When multiple API keys are configured via `OPENCODE_API_KEYS`, the proxy uses an **ApiBalancer** that:

1. **Shuffles keys** — keys are shuffled and distributed randomly each time the pool is exhausted, preventing predictable rotation patterns
2. **Tracks consecutive 429s** — each key's rate limit responses are counted independently
3. **Auto-cooldowns keys**:
   - **10 consecutive 429s** → key removed from rotation
   - **Cooldown duration**: if upstream usage data available, matches the **actual API quota reset** (`rollingUsage` ~5h, `weeklyUsage` ~until Monday UTC, `monthlyUsage` ~1st of month). Otherwise falls back to **5h** (first strike) / **1 week** (second strike)
   - A single **successful request** immediately clears all cooldowns and resets the 429 counter

#### Key state file

Cooldown state is persisted to `.cache/key-state.json`. You can manually edit this file to clear cooldowns or adjust counters:

```json
{
  "keys": {
    "sk-abc1...xyz9": {
      "consecutive429": 3,
      "cooldownUntil": "2026-05-09T18:00:00.000Z"
    }
  },
  "updatedAt": "2026-05-09T13:00:00.000Z"
}
```

| Field | Description |
|-------|-------------|
| `consecutive429` | Current consecutive 429 count (resets on success) |
| `cooldownUntil` | ISO timestamp when the key returns to rotation (5h or 1 week cooldown) |

To manually clear a key's cooldown, delete its entry or remove `cooldownUntil`, then restart the proxy.

### Key Cooldown Checker (startup + refresh)

On startup and on each model refresh, the proxy loads `.cache/key-state.json` and restores any active cooldowns into the `ApiBalancer`:

1. **`_restoreState()`** — reads the JSON file, maps `short` key fragments (`sk-abc1...xyz9`) back to full key strings from the env, sets `cooldownUntil` entries for non-expired cooldowns. Logs `[keys] restored N cooldown(s) from cache` on success.

2. **Direct disk safety net** (`fetchGoModelsRaw`) — as a second check, reads `key-state.json` directly and builds a `cooldownFromDisk` Map. The `keyInCooldown()` helper checks both the in-memory `_balancer.cooldownUntil` AND the direct disk Map. This ensures a key in cooldown is never pinged even if the `_restoreState` mapping fails silently (e.g. key format mismatch between sessions).

3. **Individual key cooldown** — before each ping in `fetchGoModelsRaw`, `keyInCooldown(k)` is called. Keys in cooldown log `[keys] key[N] in cooldown (~Xs) — skipping` and are never contacted.

4. **All-key cooldown** — if every key is in cooldown, the entire paid model fetch is skipped with `[keys] all keys in cooldown — skipping paid models`.

This means a key rate-limited from a previous session will never be pinged on restart — it's skipped entirely, saving a wasted 429 roundtrip.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `11434` | Listen port |
| `SERVER_HOST` | `127.0.0.1` | Listen host |
| `DEFAULT_MODEL` | `big-pickle` | Fallback model |
| `DEFAULT_TEMPERATURE` | — | Global temperature (e.g. `0.1`) |
| `M365CO_PORT` | — | M365 WebSocket relay port (e.g. `8765`) |
| `CACHE_ENABLED` | `true` | Prompt cache |
| `CACHE_MAX_SIZE` | `64` | Max cached entries |
| `CACHE_TTL_SEC` | `300` | Cache TTL |
| `REQUEST_LOG` | `true` | Log incoming requests to console |
| `HIDE_FREE` | `false` | Hide free models and `[FREE]`/`[GO]` tags & dividers |
| `SESSION_KEEPALIVE_ENABLED` | `true` | Keep KV cache warm between turns |
| `SESSION_KEEPALIVE_INTERVAL_MS` | `120000` | Keepalive ping interval (ms) |
| `SESSION_KEEPALIVE_IDLE_TIMEOUT_MS` | `600000` | Stop keepalive after idle (ms) |
| `SESSION_KEEPALIVE_MAX_LIFETIME_MS` | `86400000` | Cycle upstream cache after (ms, 24h) |
| `DISPLAY_REASONING` | `false` | Mirror DeepSeek thinking tokens into Cursor/VS-visible markdown blocks |
| `COLLAPSIBLE_REASONING` | `true` | Use collapsible `<details>` blocks when `DISPLAY_REASONING=true` |

---

## Models

Models appear in VS Code's Copilot list as `[FREE] Model Name`, `[FREE*] Model Name`, `[GO] Model Name`, and `[M365] M365 Copilot` — the prefix indicates free vs freemium vs paid vs M365 tier at a glance.

**Free** (always available, auto-validated): Big Pickle, MiniMax M2.5 Free, Nemotron 3 Super Free, Ring 2.6 1T Free

**Freemium** (requires API key, same Zen free models — auto-detected via ping): Big Pickle, MiniMax M2.5 Free, Nemotron 3 Super Free, Ring 2.6 1T Free — these route to the same free Zen endpoint but authenticate with your API key. On startup, each free model is pinged without a key; if it returns 401, it's retried with your API key. Models that succeed with the key are marked **freemium** and shown in orange in the console.

**Paid** (requires Go API key): fetched dynamically from OpenCode — all support tool calling

### Thinking Modes

Some models support adjustable thinking effort. These appear in the model list both as a **default entry** (no thinking mode applied) and as separate tagged entries per thinking level:

| Tag | Meaning |
|-----|---------|
| ` [LOW]` | Low reasoning effort |
| ` [MED]` | Medium reasoning effort |
| ` [HIGH]` | High reasoning effort |
| ` [MAX]` | Maximum reasoning effort |

Models that think on their own (GLM, Kimi, MiniMax, Qwen) appear without tags — their thinking is handled internally and can't be controlled.

> This thinking-mode tagging on the model name will be replaced with native thinking controls once Visual Studio adds proper support for it.

**M365 Copilot** (optional, requires `M365CO_PORT`): your company's Microsoft 365 Copilot chat — two models (Quick + Think), chat-only, no tools

---

## VS 2026 File Creation

When using VS 2026 agent mode, the proxy handles file creation and project integration:

- **New files** (`.css`, `.js`, `.py`, etc.) are created via tool calls — written to disk with absolute workspace paths
- **Project files** (`.csproj`, `.vbproj`, `.fsproj`, etc.) are handled natively — markdown code blocks pass through for VS to edit in-place
- **Auto-injection**: new files are automatically added to the project's `.csproj` with the correct `<Content Include="..." />` entry
- **Workspace root** is extracted from VS 2026's IDE state context — relative file paths are resolved automatically

To create a new file, just ask Copilot (e.g. "create me a css file called test.css"). The AI will:
1. Create the file
2. Read the project file
3. Add the file reference to the project

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tags` | GET | Ollama model list with capabilities, context length, pricing |
| `/v1/chat/completions` | POST | Chat with tool calling, streaming, cache |
| `/v1/engines/copilot-codex/completions` | POST | Inline code completions |
| `/api/show` | POST | Model detail with full capabilities, context, pricing |
| `/api/stats` | GET | Proxy metrics (uptime, model counts, concurrency, reasoning cache, key status) |
| `/api/refresh` | POST | Force refresh model list from upstream APIs |
| `/api/diagnostics` | POST | Self-test with tool-calling roundtrip (connectivity, streaming, tool verification) |
| `/health` | GET | Health check with model counts |
| `/api/version` | GET | Returns `420.96.00` |
| `/stop` | GET | Shutdown |

---

## Commands

| Command | Action |
|---------|--------|
| `r` / `restart` | Restart proxy |
| `s` / `stop` | Shut down |
| `e` / `exit` | Shut down |

Or `curl http://localhost:11434/stop`

---

## Version Check

On startup, the proxy fetches the latest ticks from [`notBlubbll/gc2oc/.version`](https://raw.githubusercontent.com/notBlubbll/gc2oc/main/.version) (raw) and compares them with the local `.version` file. If they differ, the repo has been updated — the **console title** changes to:

```
gc2oc (outdated, check github for new version)
```

The status line shows green when up to date (match) and red when outdated (mismatch).

> A GitHub Actions workflow writes the current UNIX timestamp in ms to the `version` file on each push to `main`.

---

## TPS Tracker

The proxy tracks tokens-per-second throughput and displays a rolling average in the console title.

| State | Title |
|-------|-------|
| No activity | `gc2oc` |
| After requests | `gc2oc [42.5 t/s]` |
| Outdated + TPS | `gc2oc (outdated, check github for new version) [42.5 t/s]` |

Set `SHOW_TPS=false` in `.env` to disable.

---

## Self-Updater

No git required. `update.cmd` downloads the latest `main.zip` from GitHub and applies only changed files — your config and caches are preserved.

```
update.cmd
```

| Step | What happens |
|------|-------------|
| Download | Fetches `main.zip` from the repo |
| Extract | Unzips to a temp folder |
| Compare | MD5-hashes every file — copies only new or changed files |
| Preserve | `.env`, `.cache/`, `.dist/`, `node_modules/`, `.git/` are never touched |
| Cleanup | Temp folder removed automatically |

Each file is labeled `NEW` (first time), `UPD` (changed), or `SKIP` (preserved) so you can see exactly what was updated. Restart the proxy after updating to use the new code.

### Update + Build

`update-and-build.cmd` fetches the latest source then runs `build.cmd` in one step — pull the newest code and produce a fresh `.dist` standalone.

```
update-and-build.cmd
```

---

## Caching & Validation

### Disk cache (`models.json`)

The full model list (free + paid + Pollinations + M365) is cached to `.cache/models.json`. On restart, if the key hash matches and no relevant config changed (free tier models, M365 token path), the cache is loaded instantly — no upstream API calls needed.

Invalidation triggers:
- **Key hash changes** — keys added, removed, or rotated → full refresh
- **Free tier models** changed in code — SHA256 hash of all free model IDs compared to cached value
- **M365 token** set or removed — cached M365 presence vs current env mismatch

### Key hash cache (`keyhash.json`)

SHA256 hash of all API keys (sorted, deduped) persisted to `.cache/keyhash.json`. Used at startup to detect key changes without re-parsing `.env` — if the hash matches, paid models load from disk cache instantly.

### Key state cache (`key-state.json`)

Persists per-key cooldown state between restarts. See [Key Cooldown Checker](#key-cooldown-checker-startup--refresh) above for the full load/restore flow. File is written on every cooldown state change and loaded on startup + each `refreshModels()` call.

### Prompt cache (in-memory LRU)

LRU with TTL. Responses keyed by hash of model + temperature + tool count + **session discriminator** + normalized messages. Cache hits replay instantly with zero tokens. Controlled by `CACHE_ENABLED`/`CACHE_MAX_SIZE`/`CACHE_TTL_SEC`.

### Reasonings cache (in-memory, session-scoped)

Per-session reasoning text from `<think>` tags is cached and re-attached when a cached prompt-response pair is replayed. Ensures DeepSeek-style reasoning isn't lost on cache hits. **Session-scoped** — different conversations never share reasoning data, even if they produce the same text.

#### Multi-tier reasoning key system (inspired by [yxlao/deepseek-cursor-proxy](https://github.com/yxlao/deepseek-cursor-proxy))

Reasoning is stored under multiple lookup keys to maximize cache hit rates across tool-call conversations:

| Key type | Description | Survives |
|----------|-------------|----------|
| Message signature | SHA256 of content + canonicalized tool calls | Exact match |
| Tool call ID | Per-call `id` field | Argument re-ordering |
| Tool call signature | SHA256 of tool name + normalized args | ID reassignment |
| Tool name | Plain function name | Interrupted streams, missing IDs |
| Legacy content hash | Simplified content-based hash | Backward compatibility |

**Lookup priority**: Message signature → Tool call IDs → Tool call signatures → Tool names → Legacy content hash → FIFO → Global last-reasoning fallback.

**Smart memory management**: LRU eviction at 5000 entries, preserving permanent fallback keys (`g:*:last`, `*:mdl:*`). No disk persistence — everything stays in memory for speed.

#### Thinking display

When `DISPLAY_REASONING=true`, DeepSeek reasoning tokens are mirrored into Cursor/VS Code-visible content as Markdown blocks:

- **Collapsible** (`COLLAPSIBLE_REASONING=true`, default): `<details><summary>Thinking</summary>...</details>`
- **Plain** (`COLLAPSIBLE_REASONING=false`): `<think>...</think>`

Echoed thinking blocks in incoming assistant content are automatically stripped before forwarding to upstream APIs. This prevents "reasoning doubling" when VS/Cursor echoes back the proxy-injected display blocks.

#### Reasoning recovery (400 error handling)

When the upstream DeepSeek API returns `reasoning_content must be passed back`, the proxy:

1. **Tier 1** — Retries with `thinking: false` disabled (preserves full history)
2. **Tier 2** — Strips all assistant/tool messages, keeping only system + user

This matches the recovery strategy in [yxlao/deepseek-cursor-proxy](https://github.com/yxlao/deepseek-cursor-proxy), which pioneered this approach for Cursor compatibility.

### Free model validation

On startup and refresh, each free model is pinged with a lightweight request (`max_tokens: 1`). Only responding models appear in the list. Results are cached to disk models.

### Connectivity ping

A quick `big-pickle` ping runs at startup to verify Zen API reachability: `200 ok`, `401 key denied`, or `unreachable`.

---

## Session Tracking

The proxy detects and numbers distinct conversation sessions. Each new chat tab or task context gets a monotonic session ID, visible in the console:

```
new session 3 (vscode, go/deepseek-v4-flash, c:\workspace\project)
[vscode][3]>[go/deepseek-v4-flash]
[vscode][3] stream done (42 chunks)
```

### How sessions are detected

A session is identified by hashing:

1. **All user messages before the first assistant/tool message** — VS sends the context block + the user's query as separate user messages, and the combined hash uniquely identifies each chat tab
2. **Workspace root** — same query in a different project is treated as a different session

Switching models mid-conversation keeps the same session — the message history and cached context carry over.

This means different chat tabs, different workspaces, and different models get separate session IDs with isolated caches.

### Cache isolation

All in-memory caches (prompt-response LRU, reasoning/`<think>` text) are **session-scoped** — data from one conversation never leaks into another. Two different users asking the same question will never get each other's cached responses or reasoning text.

### Session Keepalive & Continuity

When you do iterative development on the same code area, most context (system prompt, loaded files, tool results) is identical across turns. The proxy keeps the upstream LLM provider's **KV cache warm** between turns, so subsequent prompts pay **~10x cheaper cache-read pricing** instead of full input token pricing.

**Keepalive** — after `SESSION_KEEPALIVE_INTERVAL_MS` (default 2min) of inactivity, a background ping is sent to the upstream API with the same conversation prefix (`max_tokens:1`, no tools, no stream). This prevents KV cache eviction. After `SESSION_KEEPALIVE_IDLE_TIMEOUT_MS` (default 10min) of total inactivity, pinging stops. After `SESSION_KEEPALIVE_MAX_LIFETIME_MS` (default 24h), the keepalive cycles to re-establish a fresh upstream cache.

**Conversation continuity** — when VS/VS Code opens a new chat in the same workspace, the proxy detects it and:
- Enriches the system prompt with `"You previously worked on this project..."` so the model knows prior knowledge applies
- Shares the reasoning cache across sessions in the same workspace (workspace-scoped fallback when conversation-scoped lookup misses)

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_KEEPALIVE_ENABLED` | `true` | Enable/disable session keepalive |
| `SESSION_KEEPALIVE_INTERVAL_MS` | `120000` | Milliseconds between pings (min 30000) |
| `SESSION_KEEPALIVE_IDLE_TIMEOUT_MS` | `600000` | Milliseconds of inactivity before stopping |
| `SESSION_KEEPALIVE_MAX_LIFETIME_MS` | `86400000` | Max session life before cycling upstream cache (24h) |

> Inspired by [TaskSync #98](https://github.com/4regab/TaskSync/issues/98). A 40-minute agentic session with warming can cost **8x less** than a 5-minute session without.

---

## Pollinations Free Models

6 free models via [Pollinations](https://text.pollinations.ai) (GPT-OSS 20B backend, reasoning + tools):

| Model ID | Display Name | Context |
|----------|-------------|---------|
| `pol/openai-fast` | Pollinations GPT-OSS 20B | 131K |
| `pol/GPT-5` | Pollinations GPT-5 | 131K |
| `pol/Claude` | Pollinations Claude | 200K |
| `pol/Gemini` | Pollinations Gemini | 1M |
| `pol/DeepSeek` | Pollinations DeepSeek | 131K |
| `pol/Llama-4` | Pollinations Llama 4 | 131K |
| `pol/Mistral` | Pollinations Mistral | 131K |

All route through the same Pollinations `openai` backend — no API key required. By default, only the clean `pol/openai-fast` model is shown. The 6 cosplay aliases are hidden unless `HIDE_POLL_COSPLAY=false` is set.

### Pollinations env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `SHOW_POLL_MODELS` | `true` | Show Pollinations models |
| `HIDE_POLL_COSPLAY` | `true` | Hide cosplay aliases (GPT-5, Claude, Gemini, DeepSeek, Llama-4, Mistral) — only show GPT-OSS 20B |

---

## Microsoft 365 Copilot (optional)

You can route chat requests through your company's **Microsoft 365 Copilot** (the web chat at [m365.cloud.microsoft](https://m365.cloud.microsoft/chat)) as an additional model. Two models appear: `[M365] M365 Copilot Quick` and `[M365] M365 Copilot Think`.

<img alt="image" src="https://github.com/user-attachments/assets/65773e57-dbfb-4818-99e7-21c58c31683a" />


### How it works

The proxy connects to a **WebSocket relay server** that runs a browser-automated M365 Copilot session. The relay intercepts the M365 substrate WebSocket (`substrate.office.com`) and forwards chat requests/responses. This is the same approach used by [m365-copilot-openai-proxy](https://github.com/kuchris/m365-copilot-openai-proxy).

An external relay is required. The proxy uses a WebSocket-based protocol; the relay handles browser automation and M365 auth.

| Relay | Setup | Description |
|-------|-------|-------------|
| **[g365-headless-relay](https://github.com/notBlubbll/g365-headless-relay)** | `npm install` | Playwright Chromium off-screen relay — open-source, cross-platform, persistent profile |

The proxy's M365 WebSocket protocol is inspired by the same substrate-interception concept used in [m365-copilot-openai-proxy](https://github.com/kuchris/m365-copilot-openai-proxy), but the wire format is different — they are not interchangeable.

**Constraints:**
- Token expires in ~1 hour (browser session handles auth — no manual token extraction).
- System prompts and conversation history are folded into the message as plain text (labeled sections with `---` separator).
- **No tool calls or agent mode** — M365 Copilot is chat-only.

### Setup (g365-headless-relay)

1. Clone and install:
   ```bash
   git clone https://github.com/notBlubbll/g365-headless-relay
   cd g365-headless-relay
   npm install
   ```
2. First run — sign in (visible browser):
   ```bash
   debug.cmd
   ```
3. Subsequent runs — off-screen relay:
   ```bash
   start.cmd
   ```
4. Set the relay port in `.env`:
   ```env
   M365CO_PORT=8765
   ```
5. Restart the proxy.

### Relaying prompt to M365

System prompts and conversation history are folded into the message as plain text before sending to M365:

```
System instructions:
Be concise and helpful.

Prior conversation transcript:
User: What is TypeScript?
Assistant: TypeScript is a typed superset of JavaScript.

---

Tell me more about interfaces.
```

### Token refresh

When the browser session expires, restart the relay:
- **g365-headless-relay**: run `debug.cmd` to re-sign in, then `start.cmd`

No manual token copying required — the browser session handles all auth.

---

## Prompt Compression

Enriched from [OmniRoute](https://github.com/diegosouzapw/OmniRoute) (RTK+Caveman stacked compression) and [caveman](https://github.com/JuliusBrussee/caveman). 7 compression levels available:

| Level | Savings | Description |
|-------|---------|-------------|
| `off` | 0% | No compression |
| `lite` | ~15% | Whitespace collapse, dedup system prompts |
| `caveman` / `standard` | ~30% | 30+ regex rules: filler removal, context condensation, structural compression, multi-turn dedup |
| `aggressive` | ~50% | All Caveman + progressive message aging + tool result summarization |
| `ultra` | ~75% | All Aggressive + heuristic token pruning + stopword removal |
| `rtk` | 60-90% | Command-aware filters for shell/test/build/git output |
| `stacked` | 78-95% | RTK first, then Caveman — best for mixed prompts with tool logs + prose |

Functions available in `token-optimizer.js`: `compressContent()`, `compressMessages()`, `compressBest()`, `estimatedSavings()`.

---

## Build Standalone

`build.cmd` auto-detects the best available runtime and builds accordingly:

| Script | Behavior | Requires |
|--------|----------|----------|
| `build.cmd` | **Auto-detect** — tries Bun first, falls back to Node.js | Bun or Node.js |
| `build-bun.cmd` | **Explicit Bun** — single `.exe` | [Bun](https://bun.sh) |
| `build-node.cmd` | **Explicit Node.js** — portable folder | [Node.js](https://nodejs.org) |

All scripts clean `.dist/` before building but **preserve dotfiles** (`.env`, `.version`, `.cache/`, etc.) so your config survives rebuilds. `.env` is seeded only on the first build (never overwritten), while `.version` is always updated to match the current source.

### Bun path (`build-bun.cmd` or auto-detected)

Compiles to `gc2oc` (Bun standalone) + `service.exe` (C# launcher) using `bun build --compile`. The Bun runtime is embedded.

- **No runtime required** — `gc2oc` is fully self-contained (~112 MB)
- **No `node_modules`** — all JS modules bundled
- `service.exe` handles restart/update loop, `.env` loading, port cleanup, and Windows service mode
- `start.cmd` is a one-shot launcher: calls `service.exe` and exits
- `gc2oc` has no `.exe` extension — prevents accidental double-click; `service.exe` is the entry point
- Requires **Windows 10 1809+ / Windows Server 2019+** (same OS floor as Bun)

**Windows service:**
```
sc create gc2oc binPath= "C:\path\.dist\service.exe" start= auto
sc start gc2oc
```

### Node.js path (`build-node.cmd` or auto-detected fallback)

Creates a portable folder with `node` (no extension) + source + production dependencies. Run `start.cmd` or `service.exe` inside the folder.

- **No install needed** on the target machine — the Node.js binary is bundled
- Works on **Windows Server 2016+** and any Windows that runs Node.js v18+
- `service.exe` is a C# launcher with the same restart/update loop and Windows service support

### Running without building

For older Windows where Bun won't run (Server 2016), use Node.js directly:

```bash
npm run node           # Node.js fallback
start.cmd              # auto-detects Bun vs Node
```



---

## Tech Stack

**[Bun](https://bun.sh)** (preferred) → **[Node.js](https://nodejs.org)** (fallback for older Windows) · [Hono](https://hono.dev) · direct fetch

## Credits

See **[credits.md](credits.md)** for the full list of open-source projects that inspired patterns and features in gc2oc.

Key inspirations include [copilot-proxy](https://github.com/chew-z/copilot-proxy), [Qwen-Copilot-Proxy](https://github.com/edwardgj/Qwen-Copilot-Proxy), [Proxllama](https://github.com/Michediana/Proxllama), [vLLM-proxy-for-VS-Code](https://github.com/nbuckley/vLLM-proxy-for-VS-Code), [antigravity-copilot](https://github.com/punal100/antigravity-copilot), [OmniRoute](https://github.com/diegosouzapw/OmniRoute), [OpenCode Zen Provider](https://github.com/wienans/vsc-opencode-zen-chat-provider), [yxlao/deepseek-cursor-proxy](https://github.com/yxlao/deepseek-cursor-proxy), and many more.
