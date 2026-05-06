# GHCP2OpenCode

<img width="598" height="461" alt="image" src="https://github.com/user-attachments/assets/679e6447-9b4c-4554-93fb-028bc5b8ba62" />

<img width="1262" height="809" alt="image" src="https://github.com/user-attachments/assets/6db5f99e-94b4-4dad-a90c-7fa6069bec15" />

Ollama-compatible API proxy that routes **Visual Studio 2026** Copilot Chat requests to the [OpenCode](https://opencode.ai) Go subscription API.

When connected, you get access to 14 Go models — DeepSeek, Qwen, Kimi, MiniMax, GLM, MiMo — with full agent mode (tool calling).

## Compatibility

| Client | Supported |
|--------|-----------|
| Visual Studio 2026 (18.6+) | ✓ |
| Visual Studio Code | ✗ |
| SQL Server Management Studio | ✗ |

Only **Visual Studio 2026 Enterprise/Professional** is tested and supported.

## Quick Start

1. **Install [Bun](https://bun.sh)**

2. **Set your API key** in `.env`:

   ```env
   # single key
   OPENCODE_API_KEY=your-key

   # or multiple keys with rotation
   OPENCODE_API_KEYS=["key1","key2"]
   ```

3. **Run the proxy**:

   ```bash
   bun run start
   # Windows: start.cmd
   ```

4. **Configure Visual Studio 2026** — set `overrideProxyUrl` to `http://localhost:11434` and `overrideEngineUrl` to `http://localhost:11434/v1` in VS Copilot debug settings.

### Ollama Endpoint

```json
"ollama.endpoint": "http://localhost:11434"
```

## Configuration

| Variable | Default |
|----------|---------|
| `OPENCODE_API_KEY` | *(single key)* |
| `OPENCODE_API_KEYS` | *(JSON array, auto-rotates)* |
| `SERVER_PORT` | `11434` |
| `SERVER_HOST` | `127.0.0.1` |
| `DEFAULT_MODEL` | `deepseek-v4-flash` |
| `CACHE_ENABLED` | `true` |
| `CACHE_MAX_SIZE` | `64` |
| `CACHE_TTL_SEC` | `300` |

## Endpoints

| Endpoint | Format | Purpose |
|----------|--------|---------|
| `/api/tags` | Ollama | Model discovery |
| `/api/chat` | Ollama | Legacy chat |
| `/api/generate` | Ollama | Legacy completion |
| `/api/show` | Ollama | Model info |
| `/v1/chat/completions` | OpenAI | Chat (primary) |
| `/v1/models` | OpenAI | Model listing |

## Models

All models support tool calling. Vision-capable marked with ✓.

| Model | Agent | Vision |
|-------|-------|--------|
| DeepSeek V4 Flash | ✓ | |
| Qwen3.5 Plus | ✓ | ✓ |
| Qwen3.6 Plus | ✓ | ✓ |
| MiniMax M2.5 | ✓ | |
| MiniMax M2.7 | ✓ | |
| Kimi K2.5 | ✓ | ✓ |
| Kimi K2.6 | ✓ | ✓ |
| GLM-5 | ✓ | |
| GLM-5.1 | ✓ | |
| MiMo V2 Omni | ✓ | ✓ |
| MiMo V2.5 | ✓ | ✓ |
| MiMo V2 Pro | ✓ | ✓ |
| MiMo V2.5 Pro | ✓ | ✓ |

Models and metadata are fetched dynamically from [models.dev](https://models.dev/api.json).

## Prompt Cache

LRU in-memory cache with TTL. Responses are stored by hashed prompt (model + messages + tools). Cache hits replay as synthetic SSE — zero tokens, zero latency.

Cache is cleared on server restart. Disable with `CACHE_ENABLED=false`.

## Key Rotation

Set `OPENCODE_API_KEYS` as a JSON array. On 401/429 errors the failed key is cooled down and the next key is tried automatically.

## How It Works

1. VS Copilot discovers models via `/api/tags` (Ollama format)
2. Chat requests are forwarded to OpenCode Go API (`/zen/go/v1/chat/completions`)
3. Responses streamed in OpenAI SSE format with tool call normalization
4. DeepSeek `reasoning_content` cached and re-injected (VS strips non-standard fields)
5. Identity injected — model says "GitHub Copilot (enhanced by OpenCode Proxy)"

## Tech Stack

- [Bun](https://bun.sh) runtime
- [Hono](https://hono.dev) web framework
- Direct fetch — no AI SDK overhead

## Inspiration

- [OpenCode PR #25997](https://github.com/anomalyco/opencode/pull/25997) — response caching model
- [LLM-API-Key-Proxy](https://github.com/Mirrowel/LLM-API-Key-Proxy) — multi-provider proxy patterns
- [Ollama](https://github.com/ollama/ollama) — API compatibility reference
