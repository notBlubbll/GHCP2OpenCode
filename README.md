# GHCP2OpenCode

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
| VS 2026 (LocalPilot) | ✓ Supported |
| VS Code | ✓ Supported |
| SQL Server Management Studio | ✗ No Ollama provider |

> VS 2026 tested with [LocalPilot](https://marketplace.visualstudio.com/items?itemName=FutureStackSolution.LocalPilotFSS) — a local Ollama provider extension.

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


### 4. (Optional) Unlock paid models

```env
# .env
OPENCODE_API_KEY=your-go-key
OPENCODE_API_KEYS=["key1","key2"]  # multi-key rotation
```

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
| `HIDE_FREE` | `false` | Set `true` to hide free models and `[FREE]`/`[GO]` tags & dividers |

---

## Models

Models appear in VS Code's Copilot list as `[FREE] Model Name` and `[GO] Model Name` — the prefix indicates free vs paid tier at a glance.

**Free** (always available, auto-validated): Big Pickle, Hy3 Preview Free, MiniMax M2.5 Free, Nemotron 3 Super Free

**Paid** (requires Go API key): fetched dynamically from OpenCode — all support tool calling

---

## Commands

| Command | Action |
|---------|--------|
| `r` / `restart` | Restart proxy |
| `s` / `stop` | Shut down |
| `e` / `exit` | Shut down |

Or `curl http://localhost:11434/stop`

---

## Caching & Validation

### On startup

Keys from `.env` are validated against the Go API via a real chat request. Free models are pinged in parallel. Only working models appear. Results cached to disk for instant restart.

### On tags query

When VS fetches `/api/tags`, the proxy re-checks `.env` for key changes (SHA256 hash comparison). If keys changed, re-validates and rebuilds the model list automatically. Otherwise, serves from cache.

### Prompt cache

LRU in-memory with TTL. Responses keyed by hashed prompt. Hits replay instantly with zero tokens. Disable with `CACHE_ENABLED=false`.

---

## Tech Stack

**[Bun](https://bun.sh)** (preferred) → **[Node.js](https://nodejs.org)** (fallback for older Windows) · [Hono](https://hono.dev) · direct fetch

## Credits

[copilot-proxy](https://github.com/modpotato/copilot-proxy) · [OpenCode #25997](https://github.com/anomalyco/opencode/pull/25997) · [LLM-API-Key-Proxy](https://github.com/Mirrowel/LLM-API-Key-Proxy) · [Ollama](https://github.com/ollama/ollama)
