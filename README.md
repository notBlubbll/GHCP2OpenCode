# GHCP2OpenCode

Ollama-compatible API proxy that routes VS Copilot Chat requests to the [OpenCode](https://opencode.ai) Go subscription API.

When you connect VS Copilot to this proxy, you get access to 14 Go models — including DeepSeek, Qwen, Kimi, MiniMax, GLM, and MiMo — with full agent mode (tool calling) support.

## Quick Start

1. **Install [Bun](https://bun.sh)**
2. **Set your API key**

   ```env
   # .env
   OPENCODE_API_KEY=your-key
   ```

3. **Run the proxy**

   ```bash
   bun run start
   # or on Windows: start.cmd
   ```

4. **Configure VS Code** — set `github.copilot.chat.advanced.debug.overrideProxyUrl` to `http://localhost:3000` and `overrideEngineUrl` to `http://localhost:3000/v1`

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
| DeepSeek V4 Pro | |
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
| `OPENCODE_API_KEY` | *(required)* |
| `SERVER_PORT` | `3000` |
| `SERVER_HOST` | `127.0.0.1` |
| `DEFAULT_MODEL` | `deepseek-v4-flash` |

## How It Works

1. VS Copilot sends model requests in Ollama format (`/api/tags`)
2. Proxy forwards chat to the OpenCode Go API (`/zen/go/v1/chat/completions`)
3. Responses are streamed back in SSE format with proper tool call normalization
4. DeepSeek `reasoning_content` is cached and re-injected since VS strips non-standard OpenAI fields

## Tech Stack

- [Bun](https://bun.sh) runtime
- [Hono](https://hono.dev) web framework
- Direct fetch to OpenCode Go API (no AI SDK)
