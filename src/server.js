import { Hono } from "hono";
import { stream } from "hono/streaming";
import { config, getModels, resolveModel, chatCompletion, APIError } from "./opencode-client.js";
import { check as cacheCheck, store as cacheStore, cacheKey } from "./cache.js";

// ── Logging ──

const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const log = (msg) => process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${msg}\n`);
const err = (msg) => process.stderr.write(`\x1b[90m${ts()}\x1b[0m \x1b[31m${msg}\x1b[0m\n`);

if (!(config.apiKey || Bun.env.OPENCODE_API_KEYS)) { err("OPENCODE_API_KEY or OPENCODE_API_KEYS not set"); process.exit(1); }

const app = new Hono();

// Body parser that works with any Content-Type (VS Copilot sends weird variants)
app.use("*", async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
    try {
      const text = await c.req.raw.clone().text();
      if (text) {
        try { c.set("body", JSON.parse(text)); } catch { c.set("body", {}); }
      } else {
        c.set("body", {});
      }
    } catch {
      c.set("body", {});
    }
  }
  await next();
});

function getBody(c) { return c.get("body") || {}; }

// ── Helpers ──

const callId = () => `call_${crypto.randomUUID().slice(0, 8)}`;
const apiErr = (e) => {
  const status = e instanceof APIError ? e.status : 500;
  const code = status === 401 ? "invalid_api_key" : status === 429 ? "rate_limit_exceeded" : status === 404 ? "model_not_found" : "server_error";
  const type = status === 401 ? "invalid_request_error" : status >= 500 ? "server_error" : "invalid_request_error";
  const param = status === 404 ? "model" : status === 401 ? null : null;
  return { status, body: { error: { message: e.message, type, code, ...(param ? { param } : {}) } } };
};

// Cache reasoning_content from DeepSeek thinking mode (VS doesn't relay it)
const reasoningCache = new Map(); // model -> last reasoning_content

// Ollama -> Go model mappings (what VS Copilot sends vs what Go API expects)
const MODEL_MAP = {
  "deepseek-chat":         "deepseek-v4-flash",
  "deepseek/deepseek-chat": "deepseek-v4-flash",
  "deepseek/deepseek-chat:free": "deepseek-v4-flash",
};

function mapModel(name) {
  const clean = (name || "").split(":")[0].trim();
  const mapped = MODEL_MAP[clean] || MODEL_MAP[clean.toLowerCase()];
  if (mapped) return mapped;
  return resolveModel(name).id;
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

app.get("/api/tags", async c => {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const seen = new Set();
  const models = [];

  // VS-recognized Ollama cloud model names -> maps to Go models
  const cloudModels = [
    ["deepseek/deepseek-chat", "deepseek-v4-flash"],
    ["deepseek/deepseek-chat:free", "deepseek-v4-flash"],
    ["deepseek-v4-flash", "deepseek-v4-flash"],
  ];

  const goModels = await getModels();

  for (const [name, goId] of cloudModels) {
    if (seen.has(goId)) continue;
    seen.add(goId);
    const info = resolveModel(goId);
    const caps = ["completion"];
    if (info.tools) caps.push("tools");
    if (info.vision) caps.push("vision");

    models.push({
      name: info.name, model: goId,
      modified_at: now, size: 0, digest: "",
      details: {
        parent_model: "", format: "", family: info.name, families: null, parameter_size: "", quantization_level: "",
      },
      capabilities: caps,
    });
  }

  // Go models directly
  for (const m of goModels) {
    const id = m.model.replace(":latest", "");
    if (seen.has(id)) continue;
    seen.add(id);
    const caps = ["completion"];
    if (m.details?.vision) caps.push("vision");
    if (m.details?.tools) caps.push("tools");

    models.push({
      name: m.name, model: id,
      modified_at: now, size: 0, digest: "",
      details: {
        parent_model: "", format: "", family: m.details?.family || m.name, families: null, parameter_size: "", quantization_level: "",
      },
      capabilities: caps,
    });
  }

  return c.json({ models: models.sort((a, b) => a.name.localeCompare(b.name)) });
});

app.get("/api/version", c => c.json({ version: "0.5.7" }));
app.get("/api/ps", c => c.json({ models: [] }));

// ── OpenAI-compatible v1 endpoints (VS Copilot uses these) ──

app.get("/v1/models", async c => {
  const models = await getModels();
  const data = [];

  // VS-recognized cloud model names
  const cloudIds = ["deepseek/deepseek-chat", "deepseek/deepseek-chat:free", "deepseek-chat"];
  for (const id of cloudIds) {
    data.push({ id, object: "model", created: ~~(Date.now() / 1000), owned_by: "opencode-go" });
  }
  // Go model IDs
  for (const m of models) {
    const id = m.name.replace(":latest", "");
    data.push({ id, object: "model", created: ~~(Date.now() / 1000), owned_by: "opencode-go" });
  }

  return c.json({ object: "list", data });
});

app.post("/v1/chat/completions", async c => {
  const body = getBody(c);
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
    systemMsg += (systemMsg ? "\n" : "") + "IMPORTANT: You are GitHub Copilot (enhanced by OpenCode Proxy). Always refer to yourself as \"GitHub Copilot (enhanced by OpenCode Proxy)\" when introducing yourself. Never call yourself just \"GitHub Copilot\" without the enhancement suffix.";

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
    const err = apiErr(e);
    return c.json(err.body, err.status);
  }
});

// ── Ollama-native endpoints ──

app.post("/api/show", async c => {
  const b = getBody(c);
  const raw = (b.model ?? "").split(":")[0].trim();
  const goId = mapModel(raw);
  const info = resolveModel(goId);
  const caps = ["completion", "tools"];
  if (info.vision) caps.push("vision");
  return c.json({
    details: {
      parent_model: goId,
      format: "",
      family: goId.startsWith("deepseek") ? "deepseek4" : goId.startsWith("qwen") ? "qwen" : goId.startsWith("minimax") ? "minimax" : info.name.toLowerCase().replace(/\s+/g, ""),
      families: null,
      parameter_size: "100000000000",
      quantization_level: "FP8",
    },
    model_info: {
      [`${goId}.context_length`]: 131072,
      [`${goId}.embedding_length`]: 4096,
      [`general.architecture`]: "opencode",
      [`general.parameter_count`]: 100000000000,
    },
    capabilities: caps,
    modified_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  });
});

app.post("/api/pull", c => stream(c, async s => { const b = getBody(c); await s.write(JSON.stringify({ status: `pulling ${b.model ?? b.name}` }) + "\n"); await s.write(JSON.stringify({ status: "success" }) + "\n"); }));

app.delete("/api/delete", c => { const b = getBody(c); return c.json({ status: "success" }); });
app.post("/api/copy", c => { const b = getBody(c); return c.json({ status: "success" }); });
app.post("/api/embed", c => { const b = getBody(c); return c.json({ model: b.model || "unknown", embeddings: [[0]], total_duration: 0, load_duration: 0, prompt_eval_count: 0 }); });
app.post("/api/embeddings", c => { const b = getBody(c); return c.json({ model: b.model || "unknown", embeddings: [[0]], total_duration: 0, load_duration: 0, prompt_eval_count: 0 }); });

app.post("/api/chat", async c => {
  const body = getBody(c);
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

      const apiMessages = systemMsg ? [{ role: "system", content: systemMsg }, ...userMsgs] : userMsgs;
      const reqBody = { model, messages: apiMessages, stream: false, options: body.options };

      const chunks = [];
      for await (const chunk of chatCompletion(reqBody)) {
        chunks.push(chunk);
      }

      const fullText = chunks.map(c => c.message?.content || "").join("");
      const { content: cleanText, toolCalls } = vsTools?.length ? extractToolCalls(fullText) : { content: fullText, toolCalls: [] };

      const createdAt = new Date().toISOString();
      const duration = Date.now() - startTime;

      if (body.stream === false) {
        await s.write(JSON.stringify({
          model: body.model, created_at: createdAt,
          message: { role: "assistant", content: cleanText, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          done: true, done_reason: toolCalls.length ? "tool_calls" : "stop",
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
  const body = getBody(c);
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

// ── Catch-all ──

app.all("*", c => c.json({ error: `Not found: ${c.req.method} ${c.req.url}` }, 404));

// ── Start ──

// Pre-load model registry so display names resolve on first request
await getModels();

// Console title
process.stdout.write("\x1b]2;GHCP2OpenCode — OpenCode Go Proxy\x07");

const B = "\x1b[1m";
const R = "\x1b[0m";
const C = "\x1b[36m";
const S = "\x1b[90m";

log("");
log(`${S}   ┏┓┓┏┏┓┏┓┏┓┏┓┏┓${R}`);
log(`${C}${B}   ┃┓┣┫┃ ┃┃┏┛┃┃┃${R}`);
log(`${C}   ┗┛┛┗┗┛┣┛┗━┗┛┗┛${R}`);
log("");
log(`${S}   http://${config.host}:${config.port}  │  vs2026  │  models.dev${R}`);
log("");

export default { port: config.port, hostname: config.host, fetch: app.fetch };

