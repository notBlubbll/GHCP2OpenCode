# Credits

GHCP2OpenCode incorporates patterns, architecture, and features from the following open-source projects.

## Primary Inspirations

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
| [m365-copilot-openai-proxy](https://github.com/kuchris/m365-copilot-openai-proxy) | M365 Copilot integration concept — system prompt + conversation history folding into labeled plaintext, WebSocket relay pattern |
| [g365-headless-relay](https://github.com/notBlubbll/g365-headless-relay) | Playwright Chromium off-screen M365 relay — persistent browser session, shared WebSocket, serialized per-turn access |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | RTK+Caveman stacked compression up to ~95% eligible context savings (7 compression options: Lite/Caveman/Aggressive/Ultra/RTK/Stacked), Pollinations free model integration (pol/GPT-5, pol/Claude, pol/Gemini, pol/DeepSeek, pol/Llama-4, pol/Mistral) |
| [OpenCode Zen Provider](https://github.com/wienans/vsc-opencode-zen-chat-provider) | Native VS Code Language Model Chat Provider API integration (vendor: `opencode`), self-test diagnostics with tool-calling roundtrip, model registry with TTL caching from models.dev, SecretStorage-based API key management, prompt caching with per-provider cache_control hints (Anthropic ephemeral, OpenAI prompt_cache_key, OpenAI-compatible), provider options for thinking budgets/reasoning effort/text verbosity, workspace-scoped session IDs for cache key isolation, tool schema normalization and name sanitization, data part conversion (text/image/file), merge-safe provider options builder, error serialization with circular reference handling |

## Architecture

GHCP2OpenCode is a standalone proxy server (Bun/Node.js + Hono) that emulates an Ollama instance on `localhost:11434`. VS Code and VS 2026 connect via their GitHub Copilot extension's built-in Ollama provider feature.

The [OpenCode Zen VS Code Provider](https://github.com/wienans/vsc-opencode-zen-chat-provider) takes the complementary approach — it is a native VS Code extension that implements the `LanguageModelChatProvider` API directly, eliminating the need for a proxy or the Copilot extension. Both approaches bring OpenCode models to the VS Code ecosystem.

## License

This project's original code is available for use. Individual components and patterns are inspired by the projects listed above, each carrying their own licenses.
