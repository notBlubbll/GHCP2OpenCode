// 1. Bun.env bridge
if (typeof Bun === 'undefined') {
  globalThis.Bun = { env: process.env };
}

// 1b. Crypto polyfill (Node.js < 19)
if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
  const nodeCrypto = await import("node:crypto");
  globalThis.crypto = globalThis.crypto || {};
  globalThis.crypto.randomUUID = nodeCrypto.randomUUID;
}

// 2. Fetch Polyfill (Try native, then undici)
if (typeof fetch === 'undefined') {
  try {
    const mod = await import('undici');
    globalThis.fetch = mod.fetch;
    globalThis.Request = mod.Request;
    globalThis.Response = mod.Response;
    globalThis.Headers = mod.Headers;
    if (!globalThis.TransformStream && mod.TransformStream) {
      globalThis.TransformStream = mod.TransformStream;
    }
    if (!globalThis.ReadableStream && mod.ReadableStream) {
      globalThis.ReadableStream = mod.ReadableStream;
    }
  } catch (e) {
    console.error("\n[FATAL] Missing 'undici' package. Please run: npm install undici\n");
    process.exit(1);
  }
}

// 2b. Stream polyfills (Node.js < 18)
if (typeof TransformStream === 'undefined') {
  try { const { TransformStream: TS } = await import("node:stream/web"); globalThis.TransformStream = TS; } catch {}
}
if (typeof ReadableStream === 'undefined') {
  try { const { ReadableStream: RS } = await import("node:stream/web"); globalThis.ReadableStream = RS; } catch {}
}

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { cors } from "hono/cors";
import { config, getModels, initModels, resolveModel, resolveModelMetadata, isKnownModel, chatCompletion, APIError, isSeparator, isFreeTierModel, SEP_PAID, SEP_FREE, refreshModels, validateFreeModels, bgFetchDone, getKeyStatus } from "./opencode-client.js";
import { check as cacheCheck, store as cacheStore, cacheKey } from "./cache.js";
import { ModelConcurrencyManager, RateLimitError, truncateToolMessagesInPayload, checkRequestBodySize } from "./concurrency.js";
import { compactIdentity, compactToolInstructions, compactOllamaToolInstructions, compactCodeCompletionPrompt } from "./token-optimizer.js";

// ── Logging ──

const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const logReq = (c) => {
  if (!config.requestLog) return;
  if (c.req.method === "POST" && !Bun.env.DEBUG) return;
  const ua = (c.req.header("User-Agent") || "none").slice(0, 60);
  const accept = (c.req.header("Accept") || "none").slice(0, 40);
  const pathname = new URL(c.req.url).pathname;
  process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${c.req.method} ${pathname} ua=${ua} accept=${accept}\n`);
};
const log = (msg) => process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${msg}\n`);
const err = (msg) => process.stderr.write(`\x1b[90m${ts()}\x1b[0m \x1b[31m${msg}\x1b[0m\n`);

// Auto-create .env if missing
(async () => {
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(".env")) {
      fs.writeFileSync(".env", "# OpenCode API key (optional — free models work without it)\n# Get yours at: https://opencode.ai\nOPENCODE_API_KEY=\n\n# Multi-key rotation (optional)\n# OPENCODE_API_KEYS=[\\\"key1\\\",\\\"key2\\\"]\n\n# Hide free models from the list (default false)\nHIDE_FREE=false\n\n# Log incoming requests (default true)\nREQUEST_LOG=true\n\n# ── DLP / Content Blocklist (ghcp-proxy enrichment) ──\n# Enable prompt content filtering (default false)\nBLOCKLIST_ENABLED=false\n\n# Blocklist mode: \"block\" (deny with 403) or \"report\" (allow but log)\nBLOCKLIST_MODE=block\n\n# Comma-separated keywords to block (case-insensitive)\n# BLOCKLIST_KEYWORDS=secret,confidential,password\n\n# Comma-separated file name patterns to block\n# BLOCKLIST_FILEPATTERNS=passwords.txt,.env.production\n\n# Comma-separated regex patterns to block\n# BLOCKLIST_REGEX=sk-[A-Za-z0-9]{20,}\n\n# ── Concurrency & Rate Limiting (antigravity-copilot enrichment) ──\n# Maximum concurrent requests for thinking models (keep low to avoid upstream 429s)\n# CONCURRENCY_THINKING=1\n\n# Maximum concurrent requests for standard models\n# CONCURRENCY_STANDARD=3\n\n# Retry attempts for 429 / RESOURCE_EXHAUSTED errors (0 to disable)\n# RETRY_MAX=3\n\n# Base delay before first retry in ms (exponential backoff follows)\n# RETRY_BASE_DELAY_MS=100\n\n# Abort thinking model requests after this many ms (prevents quota exhaustion)\n# THINKING_TIMEOUT_MS=60000\n\n# Abort standard model requests after this many ms\n# REQUEST_TIMEOUT_MS=120000\n\n# Truncate large tool outputs (e.g., git diff) to reduce context size\n# TRUNCATE_TOOL_OUTPUT=true\n\n# Max chars kept per tool output after truncation\n# MAX_TOOL_OUTPUT_CHARS=12000\n\n# Chars kept from start of tool output when truncating\n# TOOL_OUTPUT_HEAD_CHARS=6000\n\n# Chars kept from end of tool output when truncating\n# TOOL_OUTPUT_TAIL_CHARS=2000\n\n# Absolute max request body size in bytes (returns 413 if exceeded)\n# MAX_REQUEST_BODY_BYTES=10485760\n\n# ── User Auth (ghcp-proxy allowed_users pattern) ──\n# Comma-separated list of allowed users (Proxy-Authorization or X-User-ID header)\n# ALLOWED_USERS=dev1,dev2\n\n# ── Model metadata (lmstudio-ollama-proxy enrichment) ──\n# Force all models to report full capabilities (chat/completion/vision/tools/agent)\nFORCE_ALL_CAPABILITIES=true\n\n# Force a specific context length for all models (0 = use auto-detection)\n# FORCE_CONTEXT_LENGTH=131072\n\n# Default context length fallback when not available from models.dev\nDEFAULT_CONTEXT_LENGTH=131072\n\n# Per-model metadata overrides (JSON). Example:\n# MODEL_METADATA_JSON={\"my-model\":{\"context_length\":32768,\"capabilities\":[\"chat\",\"tools\"],\"family\":\"my-family\",\"parameter_size\":\"7B\"}}\n\n# Passthrough base URL — forward unmatched paths to this upstream\n# PASSTHROUGH_BASE_URL=https://opencode.ai/zen/go/v1\n# Passthrough path prefixes (comma-separated, default /v1)\n# PASSTHROUGH_PREFIXES=/v1,/api/v0\n");
      log("Created .env — add your OPENCODE_API_KEY there to unlock paid models");
    }
  } catch { /* fs not available, ignore */ }
})();

// No API key needed — free tier works without

const app = new Hono();

// CORS — VS Code Copilot sends requests from file:// / vscode-file:// origins
app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }));

// Body parser — works on Bun + raw Node.js HTTP (body pre-read)
async function getBody(c) {
  try {
    const text = await c.req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}


// ── Helpers ──

const callId = () => `call_${crypto.randomUUID().slice(0, 8)}`;
const apiErr = (e) => {
  const status = e instanceof APIError ? e.status : 500;
  const code = status === 401 ? "invalid_api_key" : status === 429 ? "rate_limit_exceeded" : status === 404 ? "model_not_found" : status === 504 ? "gateway_timeout" : "server_error";
  const type = status === 401 ? "invalid_request_error" : status >= 500 ? "server_error" : "invalid_request_error";
  const param = status === 404 ? "model" : status === 401 ? null : null;
  return { status, body: { error: { message: e.message, type, code, ...(param ? { param } : {}) } } };
};

const oaiResp = (content, tool_calls, finish_reason, model, usage) => {
  const choice = { index: 0, message: { role: "assistant" }, finish_reason: finish_reason || "stop" };
  if (content != null) choice.message.content = content;
  if (tool_calls?.length) choice.message.tool_calls = tool_calls;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: ~~(Date.now() / 1000),
    model,
    choices: [choice],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
};

const isVSCode = (c) => {
  const ua = c.req.header("User-Agent") || "";
  return /githubcopilot/i.test(ua);
};

const isVS2026 = (c) => {
  const ua = c.req.header("User-Agent") || "";
  return /OpenAI\/.*\.NET/i.test(ua);
};

// ── Parameter normalization (camelCase → snake_case) ──
function normalizeOpenAIParams(body) {
  const n = { ...body };
  if (n.topP !== undefined && n.top_p === undefined) n.top_p = n.topP;
  if (n.frequencyPenalty !== undefined && n.frequency_penalty === undefined) n.frequency_penalty = n.frequencyPenalty;
  if (n.presencePenalty !== undefined && n.presence_penalty === undefined) n.presence_penalty = n.presencePenalty;
  if (n.maxOutputTokens !== undefined && n.max_tokens === undefined) n.max_tokens = n.maxOutputTokens;
  if (n.chatTemplateKwargs !== undefined && n.chat_template_kwargs === undefined) n.chat_template_kwargs = n.chatTemplateKwargs;
  if (n.thinkingTokenBudget !== undefined && n.thinking_token_budget === undefined) n.thinking_token_budget = n.thinkingTokenBudget;
  delete n.topP; delete n.frequencyPenalty; delete n.presencePenalty; delete n.maxOutputTokens;
  delete n.chatTemplateKwargs; delete n.thinkingTokenBudget;
  return n;
}

// ── Special token sanitization ──
function sanitizeContent(content) {
  if (typeof content !== "string") return content;
  return content
    .replace(/<\|im_start\|>[^\n]*/gi, "")
    .replace(/<\|im_end\|>/gi, "")
    .replace(/<\|endoftext\|>/gi, "")
    .replace(/<\|fim_prefix\|>/gi, "")
    .replace(/<\|fim_suffix\|>/gi, "")
    .replace(/<\|fim_middle\|>/gi, "")
    .trim();
}

// ── Think tag processor ──
function processThinkTags(text) {
  if (!text || typeof text !== "string") return { content: text || "", reasoning: null };
  const thinkRe = /<think>\s*([\s\S]*?)\s*<\/think>/gi;
  let reasoning = "";
  let clean = text;
  let match;
  while ((match = thinkRe.exec(text)) !== null) {
    reasoning += (reasoning ? "\n" : "") + match[1].trim();
    clean = clean.replace(match[0], "");
  }
  clean = clean.replace(/<\/?think>/gi, "").trim();
  return {
    content: sanitizeContent(clean),
    reasoning: reasoning ? sanitizeContent(reasoning) : null,
  };
}

// ── Reasoning field aliasing ──
function addReasoningAliases(delta, reasoningText) {
  if (!reasoningText) return delta;
  delta.reasoning = reasoningText;
  delta.reasoning_content = reasoningText;
  delta.reasoning_text = reasoningText;
  delta.thinking = reasoningText;
  return delta;
}

async function _simStream(w, base, hasTools, toolCalls, text, reasoningContent) {
  if (reasoningContent) {
    let dr = { content: "" };
    addReasoningAliases(dr, reasoningContent);
    await w({ ...base, choices: [{ index: 0, delta: dr, finish_reason: null }] });
  }
  if (hasTools) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      await w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }, finish_reason: null }] });
      await w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] });
    }
    await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  } else {
    const lines = (text || "").split("\n");
    let buffer = "";
    for (const line of lines) {
      if (buffer.length + line.length + 1 > 200 && buffer) {
        await w({ ...base, choices: [{ index: 0, delta: { content: buffer + "\n" }, finish_reason: null }] });
        buffer = line;
      } else {
        buffer += (buffer ? "\n" : "") + line;
      }
    }
    if (buffer) await w({ ...base, choices: [{ index: 0, delta: { content: buffer }, finish_reason: null }] });
    await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }
}

// Cache reasoning_content from DeepSeek thinking mode (VS doesn't relay it)
// Keyed by content/tool hash — each assistant message gets its own reasoning
const reasoningCache = new Map(); // contentHash -> reasoningContent
function _msgHash(msg) {
  if (msg.content != null) {
    const c = (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content))
      .replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
    return c.slice(0, 300);
  }
  if (msg.tool_calls?.length) {
    const tc = msg.tool_calls[0];
    return (tc.function?.name || tc.name || "") + ":" + ((tc.function?.arguments && typeof tc.function.arguments === "string") ? tc.function.arguments.replace(/\s+/g, "").slice(0, 100) : "");
  }
  return "";
}

function _cacheReasoning(msg, model, reasoning) {
  if (!reasoning) return;
  const h = _msgHash(msg);
  if (h) reasoningCache.set(h, reasoning);
  reasoningCache.set(`mdl:${model}`, reasoning); // model-key fallback
}

function _getReasoning(msg, model) {
  const h = _msgHash(msg);
  if (h && reasoningCache.has(h)) return reasoningCache.get(h);
  return reasoningCache.get(`mdl:${model}`); // fallback
}

// Ollama -> Go model mappings (what VS Copilot sends vs what Go API expects)
const MODEL_MAP = {};

function mapModel(name) {
  let clean = (name || "").split(":")[0].trim();
  clean = clean.replace(/^\s*\[(?:FREE|GO)\]\s*/i, "").trim();
  const mapped = MODEL_MAP[clean] || MODEL_MAP[clean.toLowerCase()];
  if (mapped) return mapped;
  return resolveModel(clean).id;
}

function getWorkspaceRoot(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    const m2 = c.match(/workspace root path is:\s*(\S+)/i);
    if (m2) return m2[1].replace(/\\+$/, "").replace(/\\/g, "/");
  }
  return "";
}

function _injectProjectUpdate(calls, messages, workspaceRoot) {
  // Reserved for future project file injection
}

function extractToolCalls(text, workspaceRoot = "", messages = []) {
  if (!text) return { content: text || "", toolCalls: [] };
  const calls = [];
  let remaining = text;

  // 1. Explicit ```tool blocks
  const toolBlockRe = /```tool\n(\{[\s\S]*?\})\n```/g;
  let tb;
  while ((tb = toolBlockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(tb[1]);
      calls.push({
        id: callId(), type: "function",
        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) },
      });
      remaining = remaining.replace(tb[0], "");
    } catch {}
  }

  // 2. Markdown file creation: ## `path` ```lang\ncontent\n```
  const createRe = /(?:^|\n)(?:##\s*)?`([^`\n]+\.\w+)`\s*\n```[\w-]*\n([\s\S]*?)```/gi;
  let m;
  while ((m = createRe.exec(text)) !== null) {
    let fp = m[1].replace(/\\/g, "/").trim();
    const codeContent = m[2].trim();
    if (!fp || codeContent.length < 3 || codeContent.length > 200000) continue;
    // Skip project files — VS 2026 handles these natively
    if (/\.(csproj|vbproj|fsproj|jsproj|sln|xproj|dcproj|vcxproj|wsproj|njsproj)$/i.test(fp)) continue;
    if (workspaceRoot && !/^[A-Za-z]:[/\\]/.test(fp)) {
      fp = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "") + "/" + fp;
    }
    calls.push({
      id: callId(), type: "function",
      function: { name: "create_file", arguments: JSON.stringify({ filePath: fp, content: codeContent }) },
    });
    // Keep the markdown visible — don't strip it from remaining
  }

  // Auto-inject project file update for created files
  _injectProjectUpdate(calls, messages, workspaceRoot);

  if (calls.length === 0) return { content: text, toolCalls: [] };
  // Only strip explicit ```tool blocks from content, keep markdown file creation visible
  return { content: remaining.replace(/\n{3,}/g, "\n\n").trim(), toolCalls: calls };
}

// ── GET endpoints ──

app.get("/", c => c.json({ service: "GHCP2OpenCode", status: "running" }));

app.get("/health", async c => {
  try {
    const models = await getModels();
    const real = models.filter(m => !isSeparator(m.model));
    const free = real.filter(m => isFreeTierModel(m.model));
    const paid = real.filter(m => !isFreeTierModel(m.model));
    const modelNames = real.map(m => m.name).sort();

    let status = "healthy";
    let reason = null;

    if (!real.length) {
      status = "degraded";
      reason = "No models loaded — background fetch may still be in progress";
    } else if (!config.hasKey && !paid.length && !free.length) {
      status = "unhealthy";
      reason = "No API key configured and no free models available";
    } else if (!config.hasKey && paid.length === 0) {
      status = "degraded";
      reason = "No API key configured — only free tier models available";
    } else if (config.hasKey && paid.length === 0 && free.length === 0) {
      status = "unhealthy";
      reason = "API key configured but no models loaded — key may be invalid";
    }

    const keyStatus = getKeyStatus();
    const keyStale = keyStatus.some(k => k.stale && !k.onCooldown);
    if (status === "healthy" && config.hasKey && keyStale) {
      status = "degraded";
      reason = `API key(s) not validated recently (revalidation interval: ${config.keyRevalidationMs}ms)`;
    }

    return c.json({
      status,
      ...(reason ? { reason } : {}),
      authenticated: config.hasKey,
      models_supported: modelNames,
      models_total: real.length,
      models_free: free.length,
      models_paid: paid.length,
      proxy_version: "420.96.00",
      ...(config.hasKey ? { keys: keyStatus } : {}),
    });
  } catch (e) {
    return c.json({
      status: "unhealthy",
      reason: `Health check failed: ${e.message}`,
    });
  }
});

app.get("/api/tags", handleTags);
app.get("/api/list", handleTags);
app.get("/api/models", handleTags);

async function handleTags(c) {
  if (Date.now() - _lastRefresh > 60000) {
    _lastRefresh = Date.now();
    await refreshModels();
  }
  
  const goModels = await getModels();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const seen = new Set();
  const models = [];
  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);

  for (const m of goModels) {
    const sep = isSeparator(m.model);
    if (vsc && sep) continue;
    if (!vsc && sep && config.hideFree) continue;
    if (config.hideFree && isFreeTierModel(m.model)) continue;
    const id = m.model.replace(":latest", "");
    const rawId = id.split(":")[0].trim();
    if (seen.has(rawId)) continue;
    seen.add(rawId);

    const isFree = isFreeTierModel(m.model);
    const family = m.details?.family || rawId;
    models.push({
      name: vsc ? (isFree ? "[FREE] " : "[GO] ") + m.name : m.name,
      model: vsc ? id : m.model,
      modified_at: now,
      size: m.size || 0,
      digest: m.digest || rawId,
      maxParams: m.maxParams || 0,
      details: {
        parent_model: m.details?.parent_model || "",
        format: m.details?.format || "gguf",
        ...(sep ? {} : { family: family }),
        ...(sep ? {} : { families: m.details?.families || [family] }),
        parameter_size: sep ? "" : (m.details?.parameter_size || ""),
        quantization_level: m.details?.quantization_level || "F16",
      },
    });
  }

  const realCount = models.filter(m => !isSeparator(m.model)).length;
  const divCount = models.length - realCount;
  log(`/api/tags → ${realCount} models${divCount > 0 ? ` (+${divCount} dividers)` : ""}`);
  return c.json({ models });
}

app.get("/api/version", c => c.json({ version: "420.96.00" }));

app.get("/version", async c => {
  const models = await getModels();
  const real = models.filter(m => !isSeparator(m.model)).map(m => m.name).sort();
  return c.json({
    proxy_version: "420.96.00",
    ollama_compatibility: "0.6.4",
    proxy_name: "GHCP2OpenCode",
    supported_models: real,
  });
});

let _lastRefresh = 0;
app.get("/api/ps", async c => {
  const allModels = await getModels();
  const real = allModels.filter(m => !isSeparator(m.model));
  const models = real.map(m => {
    const rawId = m.model.replace(":latest", "").split(":")[0].trim();
    const metadata = resolveModelMetadata(rawId);
    return {
      name: m.name,
      model: m.model.replace(":latest", ""),
      size: metadata.size || 0,
      digest: m.digest || rawId,
      details: {
        parent_model: "",
        format: "gguf",
        family: metadata.family,
        families: [metadata.family],
        parameter_size: metadata.parameter_size,
        quantization_level: metadata.quantization_level || "F16",
      },
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      size_vram: metadata.size_vram || 0,
      context_length: metadata.context_length,
    };
  });
  return c.json({ models });
});

// ── Stats endpoint ──
app.get("/api/stats", async c => {
  const cm = ModelConcurrencyManager.getInstance();
  const queueStats = cm.getStats();
  const models = (await getModels()).filter(m => !isSeparator(m.model));
  const free = models.filter(m => isFreeTierModel(m.model));
  const paid = models.filter(m => !isFreeTierModel(m.model));
  return c.json({
    uptime: process.uptime(),
    models: { total: models.length, free: free.length, paid: paid.length },
    concurrency: queueStats,
    reasoning_cache: reasoningCache.size,
    keys: { configured: config.hasKey },
  });
});

// ── OpenAI-compatible v1 endpoints (VS Copilot uses these) ──

function inferTokenizer(family) {
  const f = (family || "").toLowerCase();
  if (/gpt-4o|o3|o4|o1/i.test(f)) return "o200k_base";
  if (/gpt|claude/i.test(f)) return "cl100k_base";
  return "o200k_base";
}

function isPickerEnabled(modelId) {
  const c = (modelId || "").split(":")[0].trim().toLowerCase();
  if (c === config.defaultModel.split(":")[0].trim().toLowerCase()) return true;
  const pickerModels = ["gpt-4o", "gpt-4o-mini", "gpt-4", "claude-3.5-sonnet", "gemini-2.0-flash", "deepseek-chat", "deepseek-coder", "big-pickle"];
  return pickerModels.some(p => c.includes(p));
}

app.get("/v1/models", async c => {
  const models = await getModels();
  const data = [];
  const nowTs = ~~(Date.now() / 1000);

  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);
  for (const m of models) {
    if (isSeparator(m.model)) continue;
    if (config.hideFree && isFreeTierModel(m.model)) continue;
    const rawId = m.model.replace(":latest", "").split(":")[0].trim();
    const isFree = isFreeTierModel(m.model);
    const id = vsc ? (isFree ? `[FREE] ${m.name}` : `[GO] ${m.name}`) : m.name;
    const metadata = resolveModelMetadata(rawId);
    const family = metadata.family;
    const caps = metadata.capabilities || [];
    const supportsTools = caps.includes("tools") || caps.includes("agent") || (m.supports_tools ?? true);
    const ctxLen = metadata.context_length || config.defaultContextLength;
    const maxPrompt = Math.min(ctxLen - 4096, ctxLen);
    data.push({
      id,
      object: "model",
      created: nowTs,
      owned_by: "OpenCode",
      name: m.name,
      model_picker_enabled: isPickerEnabled(rawId),
      version: `${family.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}`,
      capabilities: {
        object: "model_capabilities",
        supports: {
          tool_calls: supportsTools,
          parallel_tool_calls: supportsTools,
        },
        limits: {
          max_prompt_tokens: maxPrompt,
          max_context_window_tokens: ctxLen,
          max_output_tokens: 4096,
        },
        tokenizer: inferTokenizer(family),
        type: "chat",
        family,
      },
    });
  }

  const realCount = data.filter(m => !isSeparator(m.id)).length;
  log(`/v1/models → ${realCount} models`);
  return c.json({ object: "list", data });
});

app.post("/v1/chat/completions", async c => {
  logReq(c);
  const rawBody = await getBody(c);
  const body = normalizeOpenAIParams(rawBody);
  const model = body.model || config.defaultModel;
  const messages = body.messages || [];
  const clientWantsStream = body.stream === true;
  // VS 2026: force non-streaming upstream so extractToolCalls converts markdown to create_file tool calls
  const streamMode = isVS2026(c) ? false : clientWantsStream;
  const vsTools = body.tools;
  const startTime = Date.now();
  const chatId = `chatcmpl-${startTime}`;
  const created = ~~(startTime / 1000);

  if (!messages.length) return c.json({ error: { message: "messages is required and must be non-empty", type: "invalid_request_error", code: "missing_messages" } }, 400);

  // ── Per-message validation (copilot-proxy pattern) ──
  const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") {
      return c.json({ error: { message: `message ${i} must be an object`, type: "invalid_request_error", code: "invalid_messages" } }, 400);
    }
    const role = ((m.role || "").toString()).toLowerCase().trim();
    if (!role) {
      return c.json({ error: { message: `message ${i} requires a role`, type: "invalid_request_error", code: "invalid_messages" } }, 400);
    }
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: { message: `message ${i} has invalid role: ${role}`, type: "invalid_request_error", code: "invalid_messages" } }, 400);
    }
  }
  if (!isKnownModel(model)) {
    const available = (await getModels()).filter(m => !isSeparator(m.model)).map(m => m.name).sort();
    return c.json({ error: { message: `Unsupported model: ${model}. Available models: ${available.join(", ")}`, type: "invalid_request_error", code: "unsupported_model" } }, 400);
  }

  const systemFp = `fp_${crypto.randomUUID().slice(0, 12)}`;

  // Request body size guardrail (from antigravity-copilot enrichment)
  const sizeCheck = checkRequestBodySize(rawBody);
  if (sizeCheck.exceeds) {
    log(`  request body too large: ${sizeCheck.bytes} > ${sizeCheck.limit} bytes`);
    return c.json({ error: { message: sizeCheck.message, type: "invalid_request_error", code: "request_too_large" } }, 413);
  }

  // Tool output truncation (from antigravity-copilot enrichment)
  const truncResult = truncateToolMessagesInPayload(rawBody);
  if (truncResult.truncatedMessages > 0) {
    log(`  tool output truncation: ${truncResult.truncatedMessages} messages, ${truncResult.originalTotalChars} → ${truncResult.finalTotalChars} chars`);
  }

  const cm = ModelConcurrencyManager.getInstance();
  cm.updateFromConfig();

  try {
    // Build system prompt with tool info for agent mode
    let systemMsg = "";
    const userMsgs = [];
    const goModel = mapModel(model);

    for (const m of messages) {
      const role = (m.role || "").toLowerCase().trim();
      if (role === "system") {
        systemMsg += (systemMsg ? "\n" : "") + (typeof m.content === "string" ? m.content : "");
      } else if (role === "assistant") {
          const hasTools = m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          const hasContent = m.content != null && (
            typeof m.content === "string" ? m.content.trim().length > 0 :
            Array.isArray(m.content) ? m.content.some(p => (p?.text || p?.content || "")?.trim?.()?.length > 0) :
            true
          );
          if (hasTools) {
            // Normalize tool_calls to OpenAI format (add id/type if missing)
            const normalizedCalls = m.tool_calls.map((tc, i) => ({
              id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
              type: tc.type || "function",
              function: {
                name: tc.function?.name || tc.name || "unknown",
                arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
              },
            }));
            const msg = { role: "assistant", content: null, tool_calls: normalizedCalls };
            if (m.reasoning_content) {
              msg.reasoning_content = m.reasoning_content;
            } else {
              const rc = _getReasoning(m, goModel);
              if (rc) msg.reasoning_content = rc;
            }
            userMsgs.push(msg);
          } else if (hasContent) {
            const msg = { role: "assistant", content: m.content };
            if (m.reasoning_content) {
              msg.reasoning_content = m.reasoning_content;
              _cacheReasoning(m, goModel, m.reasoning_content);
            } else {
              const rc = _getReasoning(m, goModel);
              if (rc) msg.reasoning_content = rc;
            }
            userMsgs.push(msg);
          }
      } else if (role === "user") {
        userMsgs.push(m);
      } else if (role === "tool") {
        userMsgs.push({
          role: "tool",
          tool_call_id: m.tool_call_id || "unknown",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""),
        });
      }
    }

    // Inject tool instructions into system prompt for agent mode (token-optimized)
    if (vsTools?.length) {
      systemMsg += (systemMsg ? "\n\n" : "") + compactToolInstructions();
    }

    // VS 2026: prepend project file update instruction at TOP for maximum attention
    if (isVS2026(c)) {
      systemMsg = "CRITICAL WORKFLOW for file creation:\n1. Output the new file as: ## `filename`\n```lang\ncode\n```\n2. Call get_file to read the project file (.csproj/.vbproj/.fsproj/.jsproj)\n3. Output a code block to ADD the new file to the project: ## `project.ext`\n```xml\n<ItemGroup>\n  <Content Include=\"filename\" />\n</ItemGroup>\n```\n\n" + systemMsg;
    }

    // Identity injection (token-optimized)
    systemMsg += (systemMsg ? "\n" : "") + compactIdentity(goModel);

    // Forward to Go API with native tool support
    const apiMessages = [];
    if (systemMsg) apiMessages.push({ role: "system", content: systemMsg });
    apiMessages.push(...userMsgs);

    const ollamaReq = { model: goModel, messages: apiMessages, stream: streamMode, tools: vsTools || undefined };
    if (body.chat_template_kwargs != null) ollamaReq.chat_template_kwargs = body.chat_template_kwargs;
    if (body.thinking_token_budget != null) ollamaReq.thinking_token_budget = body.thinking_token_budget;

    // Cache check (non-streaming only)
    const ck = streamMode ? null : cacheKey(ollamaReq);
    const cached = ck ? cacheCheck(ck) : null;
    if (cached) {
      const { text, toolCalls, hasTools, reasoningContent } = cached.value;

      if (clientWantsStream) {
        return stream(c, async (s) => {
          const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
          const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
          await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          await _simStream(w, base, hasTools, toolCalls, text, reasoningContent);
          await s.write("data: [DONE]\n\n");
        });
      }

      const resp = oaiResp(hasTools ? null : text, hasTools ? toolCalls : undefined, hasTools ? "tool_calls" : "stop", model);
      if (reasoningContent) {
        const choice = resp.choices[0];
        addReasoningAliases(choice.message, reasoningContent);
      }
      return c.json(resp);
    }

    // ── Stream mode: pipe directly from upstream async generator ──
    if (streamMode) {
      await cm.acquireModel(goModel);
      return stream(c, async (s) => {
        let released = false;
        const release = () => { if (!released) { released = true; cm.releaseModel(goModel); } };
        try {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };

        await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

        const deltas = [];
        let tokenCount = 0;
        let hasTools = false;
        let clientGone = false;

        try {
          for await (const chunk of chatCompletion(ollamaReq)) {
            if (clientGone) break;
            const msg = chunk.message;
            if (!msg) continue;
            deltas.push(msg);

            // Reasoning delta (DeepSeek thinking mode)
            if (msg.reasoning_content || msg.reasoning) {
              const rc = msg.reasoning_content || msg.reasoning;
              let dr = { content: "" };
              addReasoningAliases(dr, rc);
              try { await w({ ...base, choices: [{ index: 0, delta: dr, finish_reason: null }] }); }
              catch { clientGone = true; break; }
              tokenCount++;
            }

            // Content delta
            if (msg.content != null) {
              try { await w({ ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] }); }
              catch { clientGone = true; break; }
              tokenCount++;
            }

            // Tool call deltas (pass through directly — upstream sends incremental OpenAI format)
            if (msg.tool_calls?.length) {
              hasTools = true;
              try { await w({ ...base, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls }, finish_reason: null }] }); }
              catch { clientGone = true; break; }
              tokenCount++;
            }
          }
        } catch (e) {
          err(`  stream error: ${e.message}`);
          await s.write("data: [DONE]\n\n");
          return;
        }

        const finishReason = hasTools ? "tool_calls" : "stop";
        await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        await s.write("data: [DONE]\n\n");

        // Reconstruct full output from deltas
        let fullText = "";
        let reasoningContent = null;
        const tcBuilders = new Map(); // index -> accumulated tool call
        for (const d of deltas) {
          if (d.content) fullText += d.content;
          if (d.reasoning_content) reasoningContent = d.reasoning_content;
          if (d.reasoning) reasoningContent = d.reasoning;
          if (d.tool_calls?.length) {
            for (const tc of d.tool_calls) {
              const idx = tc.index ?? 0;
              let b = tcBuilders.get(idx);
              if (!b) {
                b = { id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`, type: tc.type || "function", function: { name: "", arguments: "" } };
                tcBuilders.set(idx, b);
              }
              if (tc.id) b.id = tc.id;
              if (tc.type) b.type = tc.type;
              if (tc.function?.name) b.function.name = tc.function.name;
              if (tc.function?.arguments) b.function.arguments += tc.function.arguments;
            }
          }
        }
        let allToolCalls = [...tcBuilders.values()];
        if (!allToolCalls.length && vsTools?.length && fullText) {
          const extracted = extractToolCalls(fullText, getWorkspaceRoot(messages), messages);
          if (extracted.toolCalls.length) {
            allToolCalls = extracted.toolCalls;
            fullText = extracted.content;
            hasTools = true;
          }
        }
        const rawFullText = fullText;
        const thinkResult = processThinkTags(fullText);
        if (!reasoningContent && thinkResult.reasoning) reasoningContent = thinkResult.reasoning;
        fullText = thinkResult.content;

        // Store reasoning keyed by content/tool hash (so each assistant msg gets its own)
        if (reasoningContent) {
          const virtualMsg = allToolCalls.length > 0
            ? { tool_calls: allToolCalls }
            : { content: rawFullText };
          _cacheReasoning(virtualMsg, goModel, reasoningContent);
        }

        // Cache collected output for future non-streaming hits
        if (ck) {
          cacheStore(ck, { text: fullText, toolCalls: allToolCalls, hasTools: hasTools || allToolCalls.length > 0, reasoningContent });
        }

        log(`stream done (${tokenCount} chunk${tokenCount !== 1 ? "s" : ""})`);
        } finally {
          release();
        }
      });
    }

    // ── Non-streaming: collect all chunks, then process ──
    const nonStreamReq = { ...ollamaReq, stream: false };
    let chunks;
    try {
      chunks = await cm.runRequest(goModel, async () => {
        const result = [];
        for await (const chunk of chatCompletion(nonStreamReq)) {
          result.push(chunk);
        }
        return result;
      }, true);
    } catch (e) {
      if (e.name === "RateLimitError") {
        const errResp = apiErr(new APIError(429, e.body, e.message));
        return c.json({
          error: {
            message: "Model temporarily unavailable",
            details: "The upstream model quota is exhausted. Please wait a moment and try again.",
            code: "rate_limit_exceeded",
            retryable: true,
          },
        }, 503);
      }
      throw e;
    }

    let fullText = "";
    let nativeCalls = null;
    let apiReasoning = null;
    let usage = null;
    for (const ch of chunks) {
      fullText += (ch.message?.content || "");
      if (ch.message?.tool_calls?.length && !nativeCalls) {
        nativeCalls = ch.message.tool_calls;
      }
      if (ch.message?.reasoning_content) {
        apiReasoning = ch.message.reasoning_content;
      }
      if (ch.usage) usage = ch.usage;
    }

    const rawFullText = fullText;
    const thinkResult = processThinkTags(fullText);
    let cleanText = thinkResult.content;
    let reasoningContent = apiReasoning || thinkResult.reasoning;

    let allToolCalls = [];
    if (nativeCalls?.length) {
      allToolCalls = nativeCalls;
      cleanText = "";
    } else if (vsTools?.length) {
      const extracted = extractToolCalls(fullText, getWorkspaceRoot(messages), messages);
      if (extracted.toolCalls.length) {
        allToolCalls = extracted.toolCalls;
        cleanText = extracted.content;
      }
    }
    if (!nativeCalls?.length && cleanText) {
      const postThink = processThinkTags(cleanText);
      cleanText = postThink.content;
      if (!reasoningContent && postThink.reasoning) reasoningContent = postThink.reasoning;
    }
    const hasTools = allToolCalls.length > 0;

    // Store reasoning keyed by content/tool hash
    if (reasoningContent) {
      const virtualMsg = hasTools
        ? { tool_calls: allToolCalls }
        : { content: rawFullText };
      _cacheReasoning(virtualMsg, goModel, reasoningContent);
    }

    if (ck) cacheStore(ck, { text: cleanText, toolCalls: allToolCalls, hasTools, reasoningContent });

    const resp = oaiResp(hasTools ? null : cleanText, hasTools ? allToolCalls : undefined, hasTools ? "tool_calls" : "stop", model, usage);
    if (reasoningContent) {
      const choice = resp.choices[0];
      addReasoningAliases(choice.message, reasoningContent);
    }

    // Simulate SSE streaming for clients that requested it (e.g. VS 2026)
    if (clientWantsStream) {
      return stream(c, async s => {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
        await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        await _simStream(w, base, hasTools, allToolCalls, cleanText, reasoningContent);
        await s.write("data: [DONE]\n\n");
      });
    }

    return c.json(resp);
  } catch (e) {
    err(`  Error: ${e.message}`);
    const errResp = apiErr(e);
    return c.json(errResp.body, errResp.status);
  }
});

// ── Copilot inline code completions ──
// VS Code sends to /v1/engines/copilot-codex/completions for inline completions
app.post("/v1/engines/copilot-codex/completions", async c => {
  logReq(c);
  const raw = await getBody(c);
  const body = normalizeOpenAIParams(raw);
  const model = mapModel(body.model || config.defaultModel);
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const streamMode = body.stream === true;
  const maxTokens = body.max_tokens ?? body.maxOutputTokens ?? 500;
  const temperature = body.temperature ?? (body.top_p === 0 ? 0 : 0.2);
  const stop = body.stop;
  const n = Math.min(body.n || 1, 3);
  const startTime = Date.now();
  const cmplId = `cmpl-${startTime}`;
  const created = ~~(startTime / 1000);

  if (!prompt) return c.json({ error: { message: "No prompt", type: "invalid_request_error" } }, 400);


  try {
    const systemMsg = compactCodeCompletionPrompt();
    const req = {
      model,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: prompt },
      ],
      stream: false,
    };
    if (body.temperature != null) req.options = { temperature };
    if (body.top_p != null) { req.options ||= {}; req.options.top_p = body.top_p; }
    if (maxTokens != null) { req.options ??= {}; req.options.num_predict = maxTokens; }
    if (stop) { req.options ??= {}; req.options.stop = stop; }

    const cm = ModelConcurrencyManager.getInstance();
    const chunks = [];
    await cm.acquireModel(model);
    try {
      for await (const chunk of chatCompletion(req)) {
        chunks.push(chunk);
      }
    } finally {
      cm.releaseModel(model);
    }

    const fullText = chunks.map(c => c.message?.content || "").join("");
    const { content: cleanText } = processThinkTags(fullText);
    const sanitized = sanitizeContent(cleanText || fullText);

    const completion = (text) => ({
      id: cmplId,
      object: "text_completion",
      created,
      model: body.model || config.defaultModel,
      choices: Array.from({ length: n }, (_, i) => ({
        text,
        index: i,
        logprobs: null,
        finish_reason: "stop",
      })),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    if (streamMode) {
      return stream(c, async (s) => {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: cmplId, object: "text_completion", created, model: body.model || config.defaultModel };
        const words = (sanitized || "").match(/.{1,20}/g) || [sanitized || ""];
        for (const w of words) {
          if (!w) continue;
          await w({ ...base, choices: Array.from({ length: n }, (_, i) => ({ text: w, index: i, logprobs: null, finish_reason: null })) });
        }
        await w({ ...base, choices: Array.from({ length: n }, (_, i) => ({ text: "", index: i, logprobs: null, finish_reason: "stop" })), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        await s.write("data: [DONE]\n\n");
        log(`completion done (${(sanitized || "").length} chars)`);
      });
    }

    return c.json(completion(sanitized));
  } catch (e) {
    err(`  Completion error: ${e.message}`);
    const errResp = apiErr(e);
    return c.json(errResp.body, errResp.status);
  }
});

// ── Ollama-native endpoints ──

app.post("/api/show", async c => {
  const b = await getBody(c);
  const raw = (b.model ?? b.name ?? "").split(":")[0].trim();
  if (isSeparator(raw)) {
    return c.json({
      license: "",
      modelfile: "",
      parameters: "",
      template: "",
      details: {
        parent_model: "",
        format: "",
        family: "",
        families: [],
        parameter_size: "",
        quantization_level: "",
      },
      model_info: {},
      capabilities: [],
      modified_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    });
  }
  const goId = mapModel(raw);
  const info = resolveModel(goId);
  const metadata = resolveModelMetadata(goId);
  const ctxLen = metadata.context_length || config.defaultContextLength;
  const caps = metadata.capabilities;
  const family = metadata.family;
  const paramSize = metadata.parameter_size || "";
  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);
  const isFree = isFreeTierModel(goId);
  const displayName = vsc ? (isFree ? "[FREE] " : "[GO] ") + info.name : info.name;
  return c.json({
    license: "See OpenAI license terms for this model.",
    modelfile: `# ${info.name} (via OpenCode Go)\nFROM ${goId}`,
    parameters: `num_ctx ${ctxLen}\nnum_predict 4096`,
    template: '{{ if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}{{ range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n',
    version: "1.0.0",
    billing: { multiplier: 1 },
    details: {
      parent_model: "",
      format: "gguf",
      family,
      families: [family],
      parameter_size: paramSize,
      quantization_level: metadata.quantization_level || "F16",
    },
    model_info: {
      [goId + ".context_length"]: ctxLen,
      "general.basename": displayName,
      "general.architecture": "opencode",
      "general.file_type": 15,
      "opencode.context_length": ctxLen,
    },
    capabilities: caps,
    modified_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  });
});

app.post("/api/pull", c => stream(c, async s => { const b = await getBody(c); await s.write(JSON.stringify({ status: `pulling ${b.model ?? b.name}` }) + "\n"); await s.write(JSON.stringify({ status: "success" }) + "\n"); }));

app.delete("/api/delete", async c => { const b = await getBody(c); return c.json({ status: "success" }); });
app.post("/api/copy", async c => { const b = await getBody(c); return c.json({ status: "success" }); });
app.post("/api/embed", async c => { const b = await getBody(c); return c.json({ model: b.model || "unknown", embeddings: [[0]], total_duration: 0, load_duration: 0, prompt_eval_count: 0 }); });
app.post("/api/embeddings", async c => { const b = await getBody(c); return c.json({ model: b.model || "unknown", embeddings: [[0]], total_duration: 0, load_duration: 0, prompt_eval_count: 0 }); });

app.post("/api/chat", async c => {
  logReq(c);
  const rawBody = await getBody(c);
  const body = normalizeOpenAIParams(rawBody);
  const startTime = Date.now();

  // ── Blocklist check ──
  const chatMessages = body.messages || [];

  return stream(c, async s => {
    try {
      const cm = ModelConcurrencyManager.getInstance();
      const model = mapModel(body.model);
      const messages = body.messages || [];
      const vsTools = body.tools;

      // Build messages with tool info in system prompt
      let systemMsg = "";
      const userMsgs = [];
      for (const m of messages) {
        const role = (m.role || "").toLowerCase().trim();
        if (role === "system") systemMsg += (systemMsg ? "\n" : "") + (typeof m.content === "string" ? m.content : "");
        else if (role === "assistant") {
          const hasTools = m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          const hasContent = m.content != null && (
            typeof m.content === "string" ? m.content.trim().length > 0 :
            Array.isArray(m.content) ? m.content.some(p => (p?.text || p?.content || "")?.trim?.()?.length > 0) :
            true
          );
          if (hasTools) userMsgs.push({ role: "assistant", content: null, tool_calls: m.tool_calls });
          else if (hasContent) userMsgs.push({ role: "assistant", content: m.content });
        }
        else if (role === "tool") userMsgs.push({ role: "tool", tool_call_id: m.tool_call_id || "unknown", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || "") });
        else if (role === "user") userMsgs.push(m);
        // unknown roles are silently dropped
      }

      if (vsTools?.length) {
        systemMsg += (systemMsg ? "\n\n" : "") + compactOllamaToolInstructions(vsTools);
      }

      systemMsg += (systemMsg ? "\n" : "") + compactIdentity(model);

      const apiMessages = systemMsg ? [{ role: "system", content: systemMsg }, ...userMsgs] : userMsgs;
      const reqBody = { model, messages: apiMessages, stream: false, options: body.options, format: body.format };
      if (body.chat_template_kwargs != null) reqBody.chat_template_kwargs = body.chat_template_kwargs;
      if (body.thinking_token_budget != null) reqBody.thinking_token_budget = body.thinking_token_budget;

      const chunks = [];
      await cm.acquireModel(model);
      try {
        for await (const chunk of chatCompletion(reqBody)) {
          chunks.push(chunk);
        }
      } finally {
        cm.releaseModel(model);
      }


      const fullText = chunks.map(c => c.message?.content || "").join("");
      let chatUsage = null;
      for (const c of chunks) { if (c.usage) chatUsage = c.usage; }
      const { content: cleanText, toolCalls: rawCalls } = vsTools?.length ? extractToolCalls(fullText, getWorkspaceRoot(messages)) : { content: fullText, toolCalls: [] };
      // Convert OpenAI format to Ollama format (drop id/type, parse args to object)
      const toolCalls = rawCalls.map(tc => ({
        function: { name: tc.function.name, arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })() },
      }));

      const createdAt = new Date().toISOString();
      const duration = Date.now() - startTime;

      if (body.stream === false) {
        await s.write(JSON.stringify({
          model: body.model, created_at: createdAt,
          message: { role: "assistant", content: cleanText, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          done: true, done_reason: "stop",
          total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: chatUsage?.prompt_tokens || 0, prompt_eval_duration: 0, eval_count: chatUsage?.completion_tokens || 0, eval_duration: 0,
        }) + "\n");
        return;
      }

      // Streaming NDJSON
      let tokenCount = 0;
      if (toolCalls.length) {
        await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: { role: "assistant", content: "", tool_calls: toolCalls }, done: false }) + "\n");
      } else {
        const words = (cleanText || "").match(/.{1,20}/g) || [cleanText || ""];
        for (const w of words) {
          if (!w) continue;
          await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: { role: "assistant", content: w }, done: false }) + "\n");
          tokenCount++;
        }
      }
      log(`stream done (${tokenCount} chunk${tokenCount !== 1 ? "s" : ""})`);
      await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: { role: "assistant", content: "" }, done: true, done_reason: toolCalls.length ? "tool_calls" : "stop", total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: chatUsage?.prompt_tokens || 0, prompt_eval_duration: 0, eval_count: chatUsage?.completion_tokens || 0, eval_duration: 0 }) + "\n");

    } catch (e) {
      err(`  Error: ${e.message}`);
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: "assistant", content: `Error: ${e.message}` }, done: true, done_reason: "error" }) + "\n");
    }
  });
});

app.post("/api/generate", async c => {
  logReq(c);
  const body = await getBody(c);
  const startTime = Date.now();

  return stream(c, async s => {
    try {
      const req = { model: mapModel(body.model), messages: [...(body.system ? [{ role: "system", content: body.system }] : []), { role: "user", content: body.prompt, images: body.images }], options: body.options, stream: body.stream, format: body.format };
      if (body.chat_template_kwargs != null) req.chat_template_kwargs = body.chat_template_kwargs;
      if (body.thinking_token_budget != null) req.thinking_token_budget = body.thinking_token_budget;
      let full = "";
      let tokenCount = 0;
      const genModel = mapModel(body.model);
      const cm = ModelConcurrencyManager.getInstance();
      await cm.acquireModel(genModel);
      try {
        for await (const chunk of chatCompletion(req)) {
          full += chunk.message?.content || "";
          if (body.stream === false) continue;
          await s.write(JSON.stringify({ model: body.model, created_at: chunk.created_at, response: chunk.message?.content || "", done: false }) + "\n");
          tokenCount++;
        }
      } finally {
        cm.releaseModel(genModel);
      }
      log(`stream done (${tokenCount} chunk${tokenCount !== 1 ? "s" : ""})`);
      const duration = Date.now() - startTime;
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), response: body.stream === false ? full : "", done: true, done_reason: "stop", context: null, total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: 0, prompt_eval_duration: 0, eval_count: 0, eval_duration: 0 }) + "\n");
    } catch (e) {
      err(`  Error: ${e.message}`);
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), response: `Error: ${e.message}`, done: true }) + "\n");
    }
  });
});

// ── Stop server ──

app.get("/stop", c => {
  log("Shutdown requested via /stop");
  setTimeout(() => process.exit(0), 100);
  return c.json({ status: "shutting down" });
});

// ── Passthrough proxy ──
// Forwards unmatched paths to a configurable upstream (e.g., OpenCode API)
// Controlled by PASSTHROUGH_BASE_URL env var

function isPassthroughPath(pathname) {
  if (!config.passthroughBaseUrl) return false;
  const prefixes = (Bun.env.PASSTHROUGH_PREFIXES || "/v1").split(",").map(p => p.trim()).filter(Boolean);
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function handlePassthrough(c) {
  const url = new URL(c.req.url);
  const method = c.req.method;
  let body = null;

  if (method !== "GET" && method !== "HEAD") {
    try { body = await c.req.text(); } catch {}
  }

  const incomingHeaders = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    if (!k || ["host", "connection", "content-length"].includes(k.toLowerCase())) continue;
    incomingHeaders[k] = v;
  }

  const key = config.apiKey;
  if (key && !incomingHeaders["authorization"]) {
    incomingHeaders["authorization"] = `Bearer ${key}`;
  }

  if (body && !incomingHeaders["content-type"]) {
    incomingHeaders["content-type"] = "application/json";
  }

  try {
    const upstream = await fetch(`${config.passthroughBaseUrl}${url.pathname}${url.search}`, {
      method,
      headers: incomingHeaders,
      ...(body ? { body } : {}),
    });

    const respHeaders = new Headers(upstream.headers);
    respHeaders.set("access-control-allow-origin", "*");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    err(`  Passthrough error: ${e.message}`);
    return c.json({ error: { message: `Upstream unreachable: ${e.message}`, type: "server_error", code: "bad_gateway" } }, 502);
  }
}

// ── Catch-all ──

app.all("*", c => {
  const url = new URL(c.req.url);
  if (isPassthroughPath(url.pathname)) {
    return handlePassthrough(c);
  }
  return c.json({ error: `Not found: ${c.req.method} ${c.req.url}` }, 404);
});

// ── Start ──

let serverRef = null;

// Port check: if taken (e.g. Ollama), try next
let port = config.port;
const host = config.host;
{
  const net = await import("node:net");
  const isFree = await new Promise(r => {
    const s = net.createServer();
    s.once("error", () => r(false));
    s.listen(port, host, () => { s.close(() => r(true)); });
  });
  if (!isFree) {
    log(`Port ${port} in use, trying port ${port + 1}...`);
    port++;
  }
}

// Start HTTP server immediately
if (typeof Bun !== 'undefined' && typeof Bun.serve === 'function') {
  serverRef = Bun.serve({ port, hostname: host, fetch: app.fetch, idleTimeout: 120 });
  log(`Listening on http://${host}:${serverRef.port}`);
} else if (typeof process !== 'undefined' && process.versions?.node) {
  const http = await import("http");
  serverRef = http.createServer({}, (req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const url = `http://${req.headers.host || host}${req.url}`;
      const init = { method: req.method, headers };
      if (raw && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
        init.body = raw;
      }
      const webReq = new Request(url, init);

      app.fetch(webReq).then(webRes => {
        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => res.setHeader(k, v));
        if (webRes.body) {
          const reader = webRes.body.getReader();
          const pump = () => reader.read().then(({ done, value }) => {
            if (done) { res.end(); return; }
            res.write(value);
            pump();
          });
          pump();
        } else {
          res.end();
        }
      }).catch(err => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  serverRef.timeout = 300000;
  await new Promise((resolve) => {
    serverRef.listen(port, host, () => {
      log(`Listening on http://${host}:${port}`);
      resolve();
    });
  });
}

// Load models & show banner in background
const models = await initModels();

process.stdout.write("\x1b]2;GHCP2OpenCode — OpenCode Go Proxy\x07");

const B = "\x1b[1m";
const R = "\x1b[0m";
const C = "\x1b[36m";
const S = "\x1b[90m";
const W = "\x1b[37m";
const boxW = 64;
const P = (s) => process.stdout.write(s + "\n");
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const line = (l) => {
  const pad = boxW - 4 - vis(l);
  return S + "\u2502" + R + "  " + l + " ".repeat(Math.max(0, pad)) + S + "\u2502" + R;
};
const hr = S + "\u2500".repeat(boxW - 2);

const hasPaid = models.some(m => m.model === `${SEP_PAID}:latest`);
if (hasPaid) log("\x1b[32m[status] Authenticated — free & paid models\x1b[0m");
else log("\x1b[33m[status] Free mode — no API key\x1b[0m");

P("");
P(W + "\u256d" + hr + W + "\u256e" + R);
P(line(S + B + "\u250f\u2513\u2513\u250f\u250f\u2513\u250f\u2513\u250f\u2513\u250f\u2513\u250f\u2513" + R));
P(line(S + B + "\u2503\u2513\u2523\u252b\u2503 \u2503\u2503\u250f\u251b\u2503\u2503\u2503 " + R + " " + S + "github copilot proxy" + (hasPaid ? (config.hideFree ? " \x1b[32m(go mode)\x1b[90m" : " \x1b[32m(free&go mode)\x1b[90m") : " \x1b[33m(free mode)\x1b[90m") + R));
P(line(S + B + "\u2517\u251b\u251b\u2517\u2517\u251b\u2523\u251b\u2517\u2501\u2517\u251b\u2517\u251b" + R));
P(W + "\u251c" + hr + W + "\u2524" + R);
const portLabel = port === 11434 ? `port: ${port} (default)` : `port: ${port}`;
P(line(S + portLabel + "  │  vs2026  │  models.dev" + R));
P(W + "\u251c" + hr + W + "\u2524" + R);

// Split models into free / paid by separators
const freeStart = models.findIndex(m => m.model === `${SEP_FREE}:latest`);
const paidStart = models.findIndex(m => m.model === `${SEP_PAID}:latest`);
const freeModels = models.slice(freeStart + 1, paidStart >= 0 ? paidStart : models.length);
const paidModels = paidStart >= 0 ? models.slice(paidStart + 1) : [];

function printTable(list) {
  for (const m of list) {
    const name = m.name.length > 20 ? m.name.slice(0, 19) + "\u2026" : m.name.padEnd(20);
    const id = (m.model.replace(":latest", "")).length > 24
      ? (m.model.replace(":latest", "")).slice(0, 23) + "\u2026"
      : (m.model.replace(":latest", "")).padEnd(24);
    const params = m.maxParams ? m.maxParams.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".").padEnd(9) : "-".padEnd(9);
    P(line(S + name + " \u2502 " + id + " \u2502 " + params + R));
  }
}

if (!config.hideFree && freeModels.length) {
  P(line(S + "Free: " + S + `(${freeModels.length})` + R));
  P(line(S + "Name".padEnd(20) + " \u2502 " + "ID".padEnd(24) + " \u2502 " + "Context" + R));
  printTable(freeModels);
}

if (hasPaid) {
  if (!config.hideFree) P(line(""));
  P(line(S + "Premium: " + S + `(${paidModels.length})` + R));
  P(line(S + "Name".padEnd(20) + " \u2502 " + "ID".padEnd(24) + " \u2502 " + "Context" + R));
  printTable(paidModels);
}
P(W + "\u2570" + hr + W + "\u256f" + R);
P("");

// Console commands
if (process.stdin.isTTY && typeof process.stdin.on === "function") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    const cmd = data.trim().toLowerCase();
    if (cmd === "stop" || cmd === "s" || cmd === "exit" || cmd === "e" || cmd === "quit" || cmd === "q") {
      log("Shutting down...");
      if (serverRef?.stop) serverRef.stop(true);
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => process.exit(0)); }
      setTimeout(() => process.exit(0), 2000);
    } else if (cmd === "restart" || cmd === "r") {
      log("Restarting...");
      if (serverRef?.stop) serverRef.stop(true);
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => process.exit(42)); }
      setTimeout(() => process.exit(42), 2000);
    } else if (cmd) {
      err(`Unknown command: ${cmd}`);
    }
  });
  process.stdin.resume();
  await bgFetchDone();
  log("\x1b[96mr/restart\x1b[90m | \x1b[96ms/stop\x1b[90m | \x1b[96me/exit\x1b[0m");
}

// ── OS signal handling (copilot-proxy pattern) ──
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log(`Received ${signal} — gracefully shutting down (30s timeout)...`);
  setTimeout(() => { err("Forced exit after shutdown timeout"); process.exit(1); }, 30000);
  if (serverRef?.stop) {
    serverRef.stop(true);
  } else if (serverRef?.close) {
    serverRef.closeAllConnections?.();
    serverRef.close(() => process.exit(0));
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

