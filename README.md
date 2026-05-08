# GHCP2OpenCode Proxy

Ollama-emulating proxy that connects **GitHub Copilot Chat&Agent** to the [OpenCode](https://opencode.ai) Zen + Go APIs + models.

**No key needed** — free models work immediately. Add a Go key in `.env` to unlock paid models. Full tool calling and streaming.

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
| Visual Studio 2026 **Insiders** | Ollama provider is Insiders-only |

---

## Supported Platforms

| Client | Status |
|--------|--------|
| VS 2026 Insiders | ✓ Supported |
| VS 2026 (regular) | ✗ Needs Insiders or LocalPilot |
| VS 2026 (LocalPilot) | ⚠ Unsupported but working |
| VS Code | ⚠ Supported, not fully tested |
| SQL Server Management Studio | ✗ No Ollama provider |

> **VS Code**: Works via the GitHub Copilot extension's Ollama provider, but has not been thoroughly tested. Tool calling and streaming may have edge cases.
>
> **LocalPilot (VS 2026)**: The proxy detects LocalPilot requests automatically via `## TASK` / `## [LP]` prompt prefixes and handles orphan tool messages. Not officially supported, but functional.

---

## Quick Start

### 1. Run

```bash
start.cmd          # Windows
bun run start      # Bun (preferred)
npm run node       # Node.js fallback
```

### 2. Add to Visual Studio

**Requires VS 2026 Insiders** — the Ollama provider is not in the regular release.

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
| `[GO]` | Premium — requires `OPENCODE_API_KEY` in `.env` |
| `[M365]` | Microsoft 365 Copilot — requires `M365C_TOKEN_PATH` in `.env` |


in VSCode:
<img width="1392" height="525" alt="image" src="https://github.com/user-attachments/assets/bc6a2a58-776b-4d2e-8fd8-bcf5f15b7bfa" />


### 3. (Optional) Unlock paid models

```env
# .env
OPENCODE_API_KEY=your-go-key
OPENCODE_API_KEYS=["key1","key2"]  # multi-key rotation
```

Key validation uses `GET https://opencode.ai/zen/go/v1/models` — returns 200 if valid, 401 if invalid.

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

---

## Models

Models appear in VS Code's Copilot list as `[FREE] Model Name`, `[GO] Model Name`, and `[M365] M365 Copilot` — the prefix indicates free vs paid vs M365 tier at a glance.

**Free** (always available, auto-validated): Big Pickle, Hy3 Preview Free, MiniMax M2.5 Free, Nemotron 3 Super Free

**Paid** (requires Go API key): fetched dynamically from OpenCode — all support tool calling

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

On startup, the proxy fetches the latest ticks from [`notBlubbll/GHCP2OpenCode/.version`](https://raw.githubusercontent.com/notBlubbll/GHCP2OpenCode/main/.version) (raw) and compares them with the local `.version` file. If they differ, the repo has been updated — the **console title** changes to:

```
GHCP2OpenCode (outdated, check github for new version)
```

The status line shows green when up to date (match) and red when outdated (mismatch).

> A GitHub Actions workflow writes the current UNIX timestamp in ms to the `version` file on each push to `main`.

---

## Caching & Validation

### On startup

Keys from `.env` are validated against the Go API via a real chat request. Free models are pinged in parallel. Only working models appear. Results cached to disk for instant restart.

A quick `big-pickle` ping runs at startup to verify connectivity: `200 ok`, `401 key denied`, or `unreachable`.

### On tags query

When VS fetches `/api/tags`, the proxy re-checks `.env` for key changes (SHA256 hash comparison). If keys changed, re-validates and rebuilds the model list automatically. Otherwise, serves from cache.

### Prompt cache

LRU in-memory with TTL. Responses keyed by hashed prompt. Hits replay instantly with zero tokens. Disable with `CACHE_ENABLED=false`.

### Disk cache invalidation

When `FREE_TIER_MODELS` changes in code (new providers added), the disk cache auto-invalidates via a hash of all free tier model IDs. No manual cache clearing needed.

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
| `USE_POLL_MODELS` | `true` | Enable Pollinations models |
| `HIDE_POLL` | `false` | Hide all Pollinations models |
| `HIDE_POLL_COSPLAY` | `true` | Hide cosplay aliases (GPT-5, Claude, Gemini, DeepSeek, Llama-4, Mistral) — only show GPT-OSS 20B |
| `POLLINATIONS_BASE_URL` | `https://text.pollinations.ai/openai` | Pollinations API endpoint |

---

## Microsoft 365 Copilot (optional)

You can route chat requests through your company's **Microsoft 365 Copilot** (the web chat at [m365.cloud.microsoft](https://m365.cloud.microsoft/chat)) as an additional model. Two models appear: `[M365] M365 Copilot Quick` and `[M365] M365 Copilot Think`.

<img alt="image" src="https://github.com/user-attachments/assets/65773e57-dbfb-4818-99e7-21c58c31683a" />


### How it works

The proxy connects to a **WebSocket relay server** that runs a browser-automated M365 Copilot session. The relay intercepts the M365 substrate WebSocket (`substrate.office.com`) and forwards chat requests/responses. This is the same approach used by [m365-copilot-openai-proxy](https://github.com/kuchris/m365-copilot-openai-proxy).

Two relay options are available:

| Relay | Setup | Description |
|-------|-------|-------------|
| **Local relay** (`C:\Apps\O365GHCP\Key\`) | Pre-configured | Edge-based relay bundled with the proxy — uses `start.cmd` / `debug.cmd` |
| **[g365-headless-relay](https://github.com/notBlubbll/g365-headless-relay)** | `npm install` | Playwright Chromium off-screen relay — open-source, cross-platform, persistent profile |

Both relays expose the same WebSocket API on `ws://127.0.0.1:8765` and are interchangeable.

**Constraints:**
- Token expires in ~1 hour (browser session handles auth — no manual token extraction).
- System prompts and conversation history are folded into the message as plain text (labeled sections with `---` separator).
- **No tool calls or agent mode** — M365 Copilot is chat-only.

### Setup (local relay)

1. Open `C:\Apps\O365GHCP\Key\debug.cmd` — launches Edge with visible browser
2. Sign in to M365 Copilot at [m365.cloud.microsoft/chat](https://m365.cloud.microsoft/chat)
3. Close the browser, then start the relay off-screen:
   ```bash
   C:\Apps\O365GHCP\Key\start.cmd
   ```
4. Set the relay port in `.env`:
   ```env
   M365CO_PORT=8765
   ```
5. Restart the proxy. `[M365]` models appear in the model list.

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
- **Local relay**: run `debug.cmd` to re-sign in, then `start.cmd`
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

## Tech Stack

**[Bun](https://bun.sh)** (preferred) → **[Node.js](https://nodejs.org)** (fallback for older Windows) · [Hono](https://hono.dev) · direct fetch

## Credits

See **[credits.md](credits.md)** for the full list of open-source projects that inspired patterns and features in GHCP2OpenCode.

Key inspirations include [copilot-proxy](https://github.com/chew-z/copilot-proxy), [Qwen-Copilot-Proxy](https://github.com/edwardgj/Qwen-Copilot-Proxy), [Proxllama](https://github.com/Michediana/Proxllama), [vLLM-proxy-for-VS-Code](https://github.com/nbuckley/vLLM-proxy-for-VS-Code), [antigravity-copilot](https://github.com/punal100/antigravity-copilot), [OmniRoute](https://github.com/diegosouzapw/OmniRoute), [OpenCode Zen Provider](https://github.com/wienans/vsc-opencode-zen-chat-provider), and many more.
