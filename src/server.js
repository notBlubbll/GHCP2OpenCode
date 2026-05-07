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
import { config, getModels, initModels, resolveModel, chatCompletion, APIError, isSeparator, isFreeTierModel, SEP_PAID, SEP_FREE, refreshModels, validateFreeModels } from "./opencode-client.js";
import { check as cacheCheck, store as cacheStore, cacheKey } from "./cache.js";

// ── Logging ──

const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const log = (msg) => process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${msg}\n`);
const err = (msg) => process.stderr.write(`\x1b[90m${ts()}\x1b[0m \x1b[31m${msg}\x1b[0m\n`);

// Auto-create .env if missing
(async () => {
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(".env")) {
      fs.writeFileSync(".env", "# OpenCode API key (optional — free models work without it)\n# Get yours at: https://opencode.ai\nOPENCODE_API_KEY=\n\n# Multi-key rotation (optional)\n# OPENCODE_API_KEYS=[\\\"key1\\\",\\\"key2\\\"]\n\n# Hide free models from the list (default false)\nHIDE_FREE=false\n");
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
  const code = status === 401 ? "invalid_api_key" : status === 429 ? "rate_limit_exceeded" : status === 404 ? "model_not_found" : "server_error";
  const type = status === 401 ? "invalid_request_error" : status >= 500 ? "server_error" : "invalid_request_error";
  const param = status === 404 ? "model" : status === 401 ? null : null;
  return { status, body: { error: { message: e.message, type, code, ...(param ? { param } : {}) } } };
};

const isVSCode = (c) => {
  const ua = c.req.header("User-Agent") || "";
  return /githubcopilot/i.test(ua);
};

// Cache reasoning_content from DeepSeek thinking mode (VS doesn't relay it)
const reasoningCache = new Map(); // model -> last reasoning_content

// Ollama -> Go model mappings (what VS Copilot sends vs what Go API expects)
const MODEL_MAP = {};

function mapModel(name) {
  let clean = (name || "").split(":")[0].trim();
  clean = clean.replace(/^\s*\[(?:FREE|GO)\]\s*/i, "").trim();
  const mapped = MODEL_MAP[clean] || MODEL_MAP[clean.toLowerCase()];
  if (mapped) return mapped;
  return resolveModel(clean).id;
}

// Remove aggressive regex cleanup - just extract explicit tool blocks
function extractToolCalls(text) {
  if (!text) return { content: text || "", toolCalls: [] };
  const calls = [];
  let remaining = text;

// Extract tool calls from AI text (only when tools were requested)
function extractToolCalls(text) {
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
    const fp = m[1].replace(/\\/g, "/").trim();
    const content = m[2].trim();
    if (!fp || content.length < 3 || content.length > 200000) continue;
    calls.push({
      id: callId(), type: "function",
      function: { name: "create_file", arguments: JSON.stringify({ filePath: fp, content }) },
    });
    remaining = remaining.replace(m[0], "").trim();
  }

  if (calls.length === 0) return { content: text, toolCalls: [] };
  return { content: remaining, toolCalls: calls };
}

  // If no tool blocks found, return text as-is
  if (calls.length === 0) return { content: text, toolCalls: [] };

  return { content: remaining.trim(), toolCalls: calls };
}

// ── GET endpoints ──

app.get("/", c => c.json({ service: "GHCP2OpenCode", status: "running" }));

app.get("/api/tags", handleTags);
app.get("/api/list", handleTags);

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

let _lastRefresh = 0;
app.get("/api/ps", c => c.json({ models: [] }));

// ── OpenAI-compatible v1 endpoints (VS Copilot uses these) ──

app.get("/v1/models", async c => {
  const models = await getModels();
  const data = [];

  const vsc = isVSCode(c);
  for (const m of models) {
    if (isSeparator(m.model)) continue;
    if (config.hideFree && isFreeTierModel(m.model)) continue;
    const rawId = m.model.replace(":latest", "").split(":")[0].trim();
    const isFree = isFreeTierModel(m.model);
    const id = vsc ? (isFree ? `[FREE] ${m.name}` : `[GO] ${m.name}`) : m.name;
    data.push({ id, object: "model", created: ~~(Date.now() / 1000), owned_by: "OpenCode" });
  }

  return c.json({ object: "list", data });
});

app.post("/v1/chat/completions", async c => {
  const body = await getBody(c);
  const model = body.model || config.defaultModel;
  const messages = body.messages || [];
  const streamMode = body.stream === true;
  const vsTools = body.tools;
  const startTime = Date.now();
  const chatId = `chatcmpl-${startTime}`;
  const created = ~~(startTime / 1000);

  if (!messages.length) return c.json({ error: { message: "No messages", type: "error" } }, 400);

  const systemFp = `fp_${crypto.randomUUID().slice(0, 12)}`;

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
            } else if (reasoningCache.has(goModel)) {
              msg.reasoning_content = reasoningCache.get(goModel);
            }
            userMsgs.push(msg);
          } else if (hasContent) {
            const msg = { role: "assistant", content: m.content };
            if (m.reasoning_content) {
              msg.reasoning_content = m.reasoning_content;
              reasoningCache.set(goModel, m.reasoning_content);
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

    // Inject tool descriptions into system prompt for agent mode
    if (vsTools?.length) {
      systemMsg += (systemMsg ? "\n\n" : "") + "You must use the provided tools to accomplish the user's request. Always respond with proper tool calls, not text descriptions of tool invocations.";
    }

    // Identity injection
    systemMsg += (systemMsg ? "\n" : "") + `IMPORTANT: You are GitHub Copilot (enhanced by GHCP2OC Proxy) running the ${goModel} model. When asked what model you are or what model you're running, respond with the actual model: "${goModel}" via GHCP2OC Proxy. Always refer to yourself as "GitHub Copilot (enhanced by GHCP2OC Proxy)" when introducing yourself. Never call yourself just "GitHub Copilot" without the enhancement suffix.`;

    // Forward to Go API with native tool support
    const apiMessages = [];
    if (systemMsg) apiMessages.push({ role: "system", content: systemMsg });
    apiMessages.push(...userMsgs);

    const ollamaReq = { model: goModel, messages: apiMessages, stream: false, tools: vsTools || undefined };

    // Cache check
    const ck = cacheKey(ollamaReq);
    const cached = cacheCheck(ck);
    if (cached) {
      const { text, toolCalls, hasTools, reasoningContent } = cached.value;

      if (streamMode) {
        return stream(c, async (s) => {
          const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
          const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
          await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
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
          await s.write("data: [DONE]\n\n");
        });
      }

      return c.json(oaiResp(hasTools ? null : text, hasTools ? toolCalls : undefined, hasTools ? "tool_calls" : "stop"));
    }

    const chunks = [];
    for await (const chunk of chatCompletion(ollamaReq)) {
      chunks.push(chunk);
    }

    let fullText = "";
    let nativeCalls = null;
    for (const ch of chunks) {
      fullText += (ch.message?.content || "");
      if (ch.message?.tool_calls?.length && !nativeCalls) {
        nativeCalls = ch.message.tool_calls;
      }
    }

    // Native tool_calls from API take priority; fall back to text extraction
    let allToolCalls = [];
    let cleanText = fullText;
    let reasoningContent = null;
    for (const ch of chunks) {
      if (ch.message?.reasoning_content) {
        reasoningContent = ch.message.reasoning_content;
        reasoningCache.set(goModel, ch.message.reasoning_content);
      }
    }
    if (nativeCalls?.length) {
      allToolCalls = nativeCalls;
      cleanText = "";
    } else if (vsTools?.length) {
      const extracted = extractToolCalls(fullText);
      if (extracted.toolCalls.length) {
        allToolCalls = extracted.toolCalls;
        cleanText = extracted.content;
      }
    }
    const hasTools = allToolCalls.length > 0;

    // Store in cache
    cacheStore(ck, { text: cleanText, toolCalls: allToolCalls, hasTools, reasoningContent });

    if (streamMode) {
      return stream(c, async (s) => {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };

        await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

        if (hasTools) {
          for (let i = 0; i < allToolCalls.length; i++) {
            const tc = allToolCalls[i];
            await w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }, finish_reason: null }] });
            await w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] });
          }
          await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        } else {
          // Split by lines to preserve markdown formatting
          const lines = (cleanText || "").split("\n");
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

        await s.write("data: [DONE]\n\n");
      });
    }

    return c.json(oaiResp(hasTools ? null : cleanText, hasTools ? allToolCalls : undefined, hasTools ? "tool_calls" : "stop"));
  } catch (e) {
    err(`  Error: ${e.message}`);
    const errResp = apiErr(e);
    return c.json(errResp.body, errResp.status);
  }
});

// ── Ollama-native endpoints ──

app.post("/api/show", async c => {
  const b = await getBody(c);
  const raw = (b.model ?? "").split(":")[0].trim();
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
  // Find actual context length from model cache
  const allModels = await getModels();
  const modelEntry = allModels.find(m => m.model?.replace(":latest", "") === goId || m.digest === goId || m.name.toLowerCase() === goId.toLowerCase());
  const rawMax = modelEntry?.maxParams;
  const ctxLen = Number(rawMax) || 131072;
  const caps = ["completion", "tools"];
  if (info.vision) caps.push("vision");
    const family = modelEntry?.details?.family || goId;
    const paramSize = modelEntry?.details?.parameter_size || "";
    const vsc = isVSCode(c);
    const isFree = isFreeTierModel(goId);
    const displayName = vsc ? (isFree ? "[FREE] " : "[GO] ") + info.name : info.name;
    return c.json({
      license: "See OpenAI license terms for this model.",
      modelfile: `# ${info.name} (via OpenCode Go)\nFROM ${goId}`,
      parameters: "temperature 1.0",
      template: "{{ .System }}\n\n{{ .Prompt }}",
      version: "1.0.0",
      billing: { multiplier: 1 },
      details: {
        parent_model: "",
        format: "gguf",
        family: family,
        families: [family],
        parameter_size: paramSize,
        quantization_level: "F16",
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
  const body = await getBody(c);
  const startTime = Date.now();

  return stream(c, async s => {
    try {
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
        const toolDesc = vsTools.map(t => `${t.function.name}: ${t.function.description || ""}`).join("\n");
        systemMsg += (systemMsg ? "\n\n" : "") + `Tools: ${toolDesc}\nTo use a tool, reply with:\n\`\`\`tool\n{"name": "...", "arguments": {...}}\n\`\`\`\nOr create files with:\n## \`path/file.ext\`\n\`\`\`lang\ncontent\n\`\`\``;
      }

      systemMsg += (systemMsg ? "\n" : "") + `IMPORTANT: You are GitHub Copilot (enhanced by GHCP2OC Proxy) running the ${model} model. When asked what model you are or what model you're running, respond with the actual model: "${model}" via GHCP2OC Proxy.`;

      const apiMessages = systemMsg ? [{ role: "system", content: systemMsg }, ...userMsgs] : userMsgs;
      const reqBody = { model, messages: apiMessages, stream: false, options: body.options };

      const chunks = [];
      for await (const chunk of chatCompletion(reqBody)) {
        chunks.push(chunk);
      }

      const fullText = chunks.map(c => c.message?.content || "").join("");
      const { content: cleanText, toolCalls: rawCalls } = vsTools?.length ? extractToolCalls(fullText) : { content: fullText, toolCalls: [] };
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
          total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: 0, prompt_eval_duration: 0, eval_count: 0, eval_duration: 0,
        }) + "\n");
        return;
      }

      // Streaming NDJSON
      if (toolCalls.length) {
        await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: { role: "assistant", content: "", tool_calls: toolCalls }, done: false }) + "\n");
      } else {
        const words = (cleanText || "").match(/.{1,20}/g) || [cleanText || ""];
        for (const w of words) {
          if (!w) continue;
          await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: { role: "assistant", content: w }, done: false }) + "\n");
        }
      }
      await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: { role: "assistant", content: "" }, done: true, done_reason: toolCalls.length ? "tool_calls" : "stop", total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: 0, prompt_eval_duration: 0, eval_count: 0, eval_duration: 0 }) + "\n");

    } catch (e) {
      err(`  Error: ${e.message}`);
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: "assistant", content: `Error: ${e.message}` }, done: true, done_reason: "error" }) + "\n");
    }
  });
});

app.post("/api/generate", async c => {
  const body = await getBody(c);
  const startTime = Date.now();
  return stream(c, async s => {
    try {
      const req = { model: mapModel(body.model), messages: [...(body.system ? [{ role: "system", content: body.system }] : []), { role: "user", content: body.prompt, images: body.images }], options: body.options, stream: body.stream };
      let full = "";
      for await (const chunk of chatCompletion(req)) {
        full += chunk.message?.content || "";
        if (body.stream === false) continue;
        await s.write(JSON.stringify({ model: body.model, created_at: chunk.created_at, response: chunk.message?.content || "", done: false }) + "\n");
      }
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

// ── Catch-all ──

app.all("*", c => c.json({ error: `Not found: ${c.req.method} ${c.req.url}` }, 404));

// ── Start ──

// Pre-load model registry so display names resolve on first request
const models = await initModels();

// Console title
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
if (hasPaid) log("Go API key valid - free & paid models");
else log("No Go API key - free mode only");

P("");
P(W + "\u256d" + hr + W + "\u256e" + R);
P(line(S + B + "\u250f\u2513\u2513\u250f\u250f\u2513\u250f\u2513\u250f\u2513\u250f\u2513\u250f\u2513" + R));
P(line(S + B + "\u2503\u2513\u2523\u252b\u2503 \u2503\u2503\u250f\u251b\u2503\u2503\u2503 " + R + " " + S + "github copilot proxy" + (hasPaid ? (config.hideFree ? " \x1b[32m(go mode)\x1b[90m" : " \x1b[32m(free&go mode)\x1b[90m") : " \x1b[33m(free mode)\x1b[90m") + R));
P(line(S + B + "\u2517\u251b\u251b\u2517\u2517\u251b\u2523\u251b\u2517\u2501\u2517\u251b\u2517\u251b" + R));
P(W + "\u251c" + hr + W + "\u2524" + R);
const portLabel = config.port === 11434 ? `port: ${config.port} (default)` : `port: ${config.port}`;
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

let serverRef = null;

// Start HTTP server
if (typeof Bun !== 'undefined' && typeof Bun.serve === 'function') {
  serverRef = Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch, idleTimeout: 120 });
  log(`Listening on http://${config.host}:${serverRef.port}`);
} else if (typeof process !== 'undefined' && process.versions?.node) {
  const http = await import("http");
  serverRef = http.createServer({}, (req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      // Build web Request with pre-read body
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const url = `http://${req.headers.host || config.host}${req.url}`;
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
  serverRef.timeout = 300000;  // 5 min for LLM requests
  await new Promise((resolve) => {
    serverRef.listen(config.port, config.host, () => {
      log(`Listening on http://${config.host}:${config.port}`);
      resolve();
    });
  });
}

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
  log("\x1b[96mr/restart\x1b[90m | \x1b[96ms/stop\x1b[90m | \x1b[96me/exit\x1b[0m");
}

