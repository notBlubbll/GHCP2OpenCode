# GHCP2OpenCode

<img width="1262" height="809" alt="image" src="https://github.com/user-attachments/assets/6db5f99e-94b4-4dad-a90c-7fa6069bec15" />

Ollama-compatible API proxy that routes VS Copilot Chat requests to the [OpenCode](https://opencode.ai) Go subscription API.

When you connect VS Copilot to this proxy, you get access to 14 Go models — including DeepSeek, Qwen, Kimi, MiniMax, GLM, and MiMo — with full agent mode (tool calling) support.

> **Tested with Visual Studio 2026**

## Quick Start

1. **Install [Bun](https://bun.sh)**
2. **Set your API key**

   ```env
   # .env — single key
   OPENCODE_API_KEY=your-key

   # or multiple keys with rotation
   OPENCODE_API_KEYS=["key1","key2"]
   ```

3. **Run the proxy**

   ```bash
   bun run start
   # or on Windows: start.cmd
   ```

4. **Configure VS Code** — set `github.copilot.chat.advanced.debug.overrideProxyUrl` to `http://localhost:11434` and `overrideEngineUrl` to `http://localhost:11434/v1`

### Connect via Ollama

You can register the proxy as an Ollama instance using the project port:

```json
// settings.json
"ollama.endpoint": "http://localhost:11434"
```

## Endpoints

| Endpoint | Format | Used By |
|----------|--------|---------|
| `/api/tags` | Ollama | Copilot model discovery |
| `/api/chat` | Ollama | Legacy chat |
| `/api/generate` | Ollama | Legacy completion |
| `/api/show` | Ollama | Model info |
| `/v1/chat/completions` | OpenAI | Copilot chat (primary) |
| `/v1/models` | OpenAI | Model listing |

## Models

All models support tool calling (agent mode). Vision-capable models are listed below.

| Model | Vision |
|-------|--------|
| DeepSeek V4 Flash | |
| Qwen3.5 Plus | ✓ |
| Qwen3.6 Plus | ✓ |
| MiniMax M2.5 | |
| MiniMax M2.7 | |
| Kimi K2.5 | ✓ |
| Kimi K2.6 | ✓ |
| GLM-5 | |
| GLM-5.1 | |
| MiMo V2 Omni | ✓ |
| MiMo V2.5 | ✓ |
| MiMo V2 Pro | ✓ |
| MiMo V2.5 Pro | ✓ |

## Configuration

| Variable | Default |
|----------|---------|
| `OPENCODE_API_KEY` | *(single key)* |
| `OPENCODE_API_KEYS` | *(JSON array)* |
| `SERVER_PORT` | `11434` |
| `SERVER_HOST` | `127.0.0.1` |
| `DEFAULT_MODEL` | `deepseek-v4-flash` |
| `CACHE_ENABLED` | `true` |
| `CACHE_MAX_SIZE` | `64` |
| `CACHE_TTL_SEC` | `300` |

### Prompt Cache

Client-side LRU response cache with TTL expiration. Caches LLM responses by hashing the normalized prompt (model + messages + tools). On cache hit, replays the response as a synthetic SSE stream — zero token cost, zero latency.

Inspired by [OpenCode PR #25997](https://github.com/anomalyco/opencode/pull/25997), [LLM-API-Key-Proxy](https://github.com/Mirrowel/LLM-API-Key-Proxy), and [fluxkv](https://github.com/Kushalk0677/fluxkv).

Cache is cleared on server restart (in-memory).

## How It Works

1. VS Copilot sends model requests in Ollama format (`/api/tags`)
2. Proxy forwards chat to the OpenCode Go API (`/zen/go/v1/chat/completions`)
3. Responses are streamed back in SSE format with proper tool call normalization
4. DeepSeek `reasoning_content` is cached and re-injected since VS strips non-standard OpenAI fields

## Tech Stack

- [Bun](https://bun.sh) runtime
- [Hono](https://hono.dev) web framework
- Direct fetch to OpenCode Go API (no AI SDK)
