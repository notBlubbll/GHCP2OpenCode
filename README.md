# GHCP2OpenCode

Ollama-compatible proxy that bridges **Visual Studio 2026 Copilot Chat** with the [OpenCode](https://opencode.ai) Zen + Go APIs.

**Free models** work out of the box — no API key needed. Add a Go key in `.env` to unlock paid models. All models appear in the VS model selector with tool calling and streaming.

---

## Screenshots

**Console** — model table with context lengths, key status, commands:

<img width="604" height="622" alt="Console banner" src="https://github.com/user-attachments/assets/dbb734c3-0f2e-4d9b-84b8-f11a2fc6fb1e" />

**Agent mode** — tool calling with free and paid models:

<img alt="Free model agent mode" src="https://github.com/user-attachments/assets/eb27e58e-0b64-4634-a50b-ae4cf2a8dd77">

<img alt="Paid model agent mode" src="https://github.com/user-attachments/assets/72e41978-1da3-42d5-8ad3-73a84d88254f">

---

## Quick Start

### 1. Run the proxy

```bash
start.cmd          # Windows
bun run start      # Bun (preferred)
npm run node       # Node.js (fallback)
```

### 2. Configure Visual Studio

**Requires VS 2026 Insiders.** Add a new Ollama provider pointing to `http://localhost:11434` (or the port shown in console). The supported models appear automatically.

- `overrideProxyUrl` → `http://localhost:11434`
- `overrideEngineUrl` → `http://localhost:11434/v1`

### 3. (Optional) Add your API key

```env
# .env
OPENCODE_API_KEY=your-key
# or multi-key rotation:
OPENCODE_API_KEYS=["key1","key2"]
```

---

## Compatibility

| Client | Status |
|--------|--------|
| VS 2026 Insiders (18.6+) | Supported |
| VS 2026 (regular) | No — needs Insiders |
| VS Code / SSMS | No |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_API_KEY` | — | API key |
| `OPENCODE_API_KEYS` | — | JSON array, auto-rotates on 401/429 |
| `SERVER_PORT` | `11434` | Listen port |
| `SERVER_HOST` | `127.0.0.1` | Listen host |
| `DEFAULT_MODEL` | `big-pickle` | Fallback model |
| `DEFAULT_TEMPERATURE` | — | Global temperature (e.g. `0.1`) |
| `CACHE_ENABLED` | `true` | Prompt response cache |
| `CACHE_MAX_SIZE` | `64` | Max cached entries |
| `CACHE_TTL_SEC` | `300` | Cache TTL |

---

## Models

All support tool calling. Free models work without a key and are validated (pinged) before appearing. Paid models require a Go API key.

**Free** — Big Pickle, Hy3 Preview Free, MiniMax M2.5 Free, Nemotron 3 Super Free (+ 2 deprecated)

**Paid** — fetched dynamically from OpenCode Go API when a key is set.

---

## Commands

Type in the console window:

| Command | Action |
|---------|--------|
| `r` / `restart` | Restart proxy |
| `s` / `stop` | Shut down |
| `e` / `exit` | Shut down |

Or HTTP: `curl http://localhost:11434/stop`

---

## Caching

### Key validation

On startup, the proxy tests every configured key (`OPENCODE_API_KEY` + each key in `OPENCODE_API_KEYS`) against the Go API with a real chat request. If a 401 is returned for ALL keys, the proxy stays in free mode. If any key passes, paid models are loaded. A hash of the working keys is persisted to `.ghcp2oc_keyhash.json` — changing keys auto-triggers re-validation on next startup or tags query.

### Model validation

In parallel, each free model is pinged with a minimal request to `/zen/v1/chat/completions`. Only responding models appear in the selector. Models flagged `deprecated` by [models.dev](https://models.dev) are auto-hidden. Paid models are fetched from `/zen/go/v1/models` with the validated key. Results cached to `.ghcp2oc_models.json`.

### Prompt cache

LRU in-memory with TTL. Responses keyed by hashed prompt. Cache hits replay instantly — zero tokens. Disable with `CACHE_ENABLED=false`.

---

## How It Works

1. VS discovers models via `/api/tags` (Ollama format)
2. Chat → OpenCode API (`/zen/go/v1/chat/completions`)
3. Responses streamed in OpenAI SSE with tool call normalization
4. Identity: "GitHub Copilot (enhanced by OpenCode Proxy)"

---

## Tech Stack

**[Bun](https://bun.sh)** (preferred) → **[Node.js](https://nodejs.org)** (fallback for Windows Server 2016 etc.) · [Hono](https://hono.dev) · direct fetch

## Credits

- [copilot-proxy](https://github.com/modpotato/copilot-proxy) · [OpenCode #25997](https://github.com/anomalyco/opencode/pull/25997) · [LLM-API-Key-Proxy](https://github.com/Mirrowel/LLM-API-Key-Proxy) · [Ollama](https://github.com/ollama/ollama)
