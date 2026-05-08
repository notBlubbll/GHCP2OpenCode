# GHCP2OpenCode — Summary

## What it is

An Ollama-emulating proxy that connects GitHub Copilot (VS 2026 / VS Code) to OpenCode Zen, OpenCode Go, Pollinations, and M365 Copilot APIs. Runs on `localhost:11434` — VS sees it as a local Ollama instance.

**One command:** `start.cmd` — works immediately with free models, no key needed.

## Model Sources

| Tier | Source | Count | Key Required |
|------|--------|-------|:---:|
| Free | OpenCode Zen | 6 | No |
| Pollinations | text.pollinations.ai | 1 (+6 cosplay aliases) | No |
| Paid | OpenCode Go | Dynamic (API fetch) | Yes |
| M365 | Microsoft 365 Copilot | 2 (Quick + Think) | Browser session |

## Client Support

| Client | Status |
|--------|--------|
| VS 2026 Insiders | Full support — agent mode, file creation, project integration |
| VS Code | Supported — `[FREE]`/`[GO]`/`[M365]` prefixes in model picker |
| LocalPilot (VS 2026) | Detected automatically, orphan tool messages cleaned |

## Files

| File | Role |
|------|------|
| `src/server.js` | HTTP server, routing, client detection, response formatting |
| `src/opencode-client.js` | Model registry, upstream API calls, key rotation |
| `src/m365-client.js` | M365 Copilot WebSocket relay client |
| `src/concurrency.js` | Semaphore-based concurrency, retry, truncation |
| `src/cache.js` | LRU prompt-response cache with TTL |
| `src/token-optimizer.js` | 7-level prompt compression |

## Key Features

- **Tool calling** — native upstream tool calls for paid models, markdown extraction for VS 2026
- **Streaming** — true SSE from upstream, simulated SSE for VS 2026 (non-streaming → tool extraction)
- **Key rotation** — round-robin with cooldown on 401/429
- **Compression** — 7 levels (off through stacked), auto-selected per model tier
- **Caching** — in-memory LRU (64 entries, 300s TTL) + disk model cache
- **M365** — WebSocket relay via browser automation, two relay options (local + headless)
- **Auto-restart** — exit code 42 triggers restart loop

## Quick Start

```bash
start.cmd          # Windows
bun run start      # Bun
npm run node       # Node.js
```

Then add `http://localhost:11434` as Ollama provider in VS Copilot settings.
