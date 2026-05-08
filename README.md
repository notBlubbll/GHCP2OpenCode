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
| `CACHE_ENABLED` | `true` | Prompt cache |
| `CACHE_MAX_SIZE` | `64` | Max cached entries |
| `CACHE_TTL_SEC` | `300` | Cache TTL |
| `REQUEST_LOG` | `true` | Log incoming requests to console |
| `HIDE_FREE` | `false` | Hide free models and `[FREE]`/`[GO]` tags & dividers |

---

## Models

Models appear in VS Code's Copilot list as `[FREE] Model Name` and `[GO] Model Name` — the prefix indicates free vs paid tier at a glance.

**Free** (always available, auto-validated): Big Pickle, Hy3 Preview Free, MiniMax M2.5 Free, Nemotron 3 Super Free

**Paid** (requires Go API key): fetched dynamically from OpenCode — all support tool calling

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
| `/api/tags` | GET | Ollama model list |
| `/v1/chat/completions` | POST | Chat with tool calling, streaming, cache |
| `/v1/engines/copilot-codex/completions` | POST | Inline code completions |
| `/api/stats` | GET | Proxy metrics (uptime, model counts, concurrency, reasoning cache, key status) |
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

On startup, the proxy fetches the latest version from [`notBlubbll/GHCP2OpenCode/version`](https://raw.githubusercontent.com/notBlubbll/GHCP2OpenCode/main/version) (raw) and compares it with the local version (`420.96.00`).

If the remote version differs from the local version, the **console title** changes to:

```
GHCP2OpenCode (outdated, check github for new version)
```

When up to date, the title shows `GHCP2OpenCode — OpenCode Go Proxy`.

The proxy also writes the current time (in millisecond ticks) to a `version` file on disk to track the last run timestamp.

---

## Caching & Validation

### On startup

Keys from `.env` are validated against the Go API via a real chat request. Free models are pinged in parallel. Only working models appear. Results cached to disk for instant restart.

A quick `big-pickle` ping runs at startup to verify connectivity: `200 ok`, `401 key denied`, or `unreachable`.

### On tags query

When VS fetches `/api/tags`, the proxy re-checks `.env` for key changes (SHA256 hash comparison). If keys changed, re-validates and rebuilds the model list automatically. Otherwise, serves from cache.

### Prompt cache

LRU in-memory with TTL. Responses keyed by hashed prompt. Hits replay instantly with zero tokens. Disable with `CACHE_ENABLED=false`.

---

## Tech Stack

**[Bun](https://bun.sh)** (preferred) → **[Node.js](https://nodejs.org)** (fallback for older Windows) · [Hono](https://hono.dev) · direct fetch

## Credits

This project incorporates patterns and features from the following open-source projects:

| Project | Key Contributions |
|---------|-------------------|
| [copilot-proxy](https://github.com/chew-z/copilot-proxy) | Ollama provider pattern, `/api/tags` + `/api/show`, optimized HTTP client (connection pooling), true upstream SSE streaming (per-chunk delta piping), graceful shutdown (SIGINT/SIGTERM/SIGHUP), per-message role validation, auto-enable `tool_stream` |
| [Qwen-Copilot-Proxy](https://github.com/edwardgj/Qwen-Copilot-Proxy) | Health status granularity (`healthy`/`degraded`/`unhealthy`), key freshness tracking, `/version` endpoint, configurable `MAX_RETRIES`, input validation |
| [raven](https://github.com/nocoo/raven) | Bun+Hono architecture, SQLite tracking pattern |
| [Proxllama](https://github.com/Michediana/Proxllama) | SSE→NDJSON streaming conversion, `num_ctx`/`num_predict` in `/api/show`, chat template, `format`→`response_format` mapping, `stop` parameter forwarding, streaming token counting, real upstream usage stats propagation |
| [GHCOllamaMiniMaxProxy](https://github.com/jaggerjack61/GHCOllamaMiniMaxProxy) | Configurable model names, thinking budgets, per-model defaults |
| [vLLM-proxy-for-VS-Code](https://github.com/nbuckley/vLLM-proxy-for-VS-Code) | Parameter normalization (camelCase→snake_case), think tag parsing, special token sanitization, reasoning field aliasing, port availability check, model metadata inference |
| [copilot-ollama](https://github.com/andydixon/copilot-ollama) | Inline code completions endpoint, Copilot-compatible `/v1/models` capabilities |
| [OpenCode #25997](https://github.com/anomalyco/opencode/pull/25997) | OpenCode skills integration |
| [LLM-API-Key-Proxy](https://github.com/Mirrowel/LLM-API-Key-Proxy) | Key rotation patterns |
| [Ollama](https://github.com/ollama/ollama) | API interface specification |
| [ghcp-proxy](https://github.com/kylercai/ghcp-proxy) | User auth/identity extraction, structured request logging, stats endpoint |
| [antigravity-copilot](https://github.com/punal100/antigravity-copilot) | Concurrency queue (semaphore-based, thinking/standard separation), aggressive retry with exponential backoff (Antigravity IDE-style), per-model request timeouts, tool output truncation, request body size limit, client abort propagation, configurable concurrency limits |
| [lmstudio-ollama-proxy](https://github.com/NeoTech/lmstudio-ollama-proxy) | Per-model metadata overrides (`MODEL_METADATA_JSON`), configurable context length (`FORCE_CONTEXT_LENGTH`/`DEFAULT_CONTEXT_LENGTH`), force capabilities (`FORCE_ALL_CAPABILITIES`), passthrough proxy, improved `/api/ps`, capabilities inference |
| [copilot-plugin-mcp-server](https://github.com/barrersoftware/copilot-plugin-mcp-server) | Token optimization — 25-65% token reduction via description compression, schema simplification, and compact identity/tool prompts |
