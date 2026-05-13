// 1. Bun.env bridge
if (typeof Bun === 'undefined') {
  globalThis.Bun = { env: process.env };
}
try { process.stderr.write(`[gc2oc] startup pid=${process.pid} argv=${JSON.stringify(process.argv)}\r\n`); } catch {}

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
import { compress } from "hono/compress";
import { config, getModels, initModels, resolveModel, resolveModelMetadata, isKnownModel, chatCompletion, APIError, isSeparator, isFreeTierModel, isPollModel, isM365Model, SEP_PAID, SEP_FREE, SEP_FREE_P, SEP_M365, refreshModels, validateFreeModels, bgFetchDone, getKeyStatus, fetchWithAgent, getThinkingModes, parseThinkingMode } from "./opencode-client.js";
import { check as cacheCheck, store as cacheStore, cacheKey } from "./cache.js";
import { ModelConcurrencyManager, RateLimitError, truncateToolMessagesInPayload, checkRequestBodySize } from "./concurrency.js";
import { compactIdentity, compactToolInstructions, compactOllamaToolInstructions, compactCodeCompletionPrompt, compressMessages } from "./token-optimizer.js";
import { m365ChatCompletion, m365ChatCompletionStream, M365CopilotError } from "./m365-client.js";
import { handleServiceCommand, runAsService } from "./win-service.js";
import { log, error as logErr, reqLog } from "./logger.js";

// ── Service command routing (early exit for install/uninstall) ──
{
  const svcCmd = await handleServiceCommand(process.argv);
  if (svcCmd.handled) process.exit(svcCmd.exitCode);
}

// ── Service mode detection ──
const _isServiceMode = process.argv.includes("--service") || process.env.GC2OC_SERVICE === "1";

// ── Version check ──
const VERSION_API_URL = "https://api.github.com/repos/notBlubbll/gc2oc/contents/.version";
const VERSION_FILE = ".version";

function setConsoleTitle(title) {
  try { process.stdout.write(`\x1b]2;${title}\x1b\x07`); } catch {}
  try { process.title = title; } catch {}
}

async function showToast(title, body) {
  if (process.platform !== "win32") return;
  try {
    const { exec } = await import("node:child_process");
    const tidy = (s) => String(s).replace(/'/g, "''");
    const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $tpl.GetElementsByTagName('text')[0].AppendChild($tpl.CreateTextNode('${tidy(title)}')) | Out-Null; $tpl.GetElementsByTagName('text')[1].AppendChild($tpl.CreateTextNode('${tidy(body)}')) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('gc2oc').Show([Windows.UI.Notifications.ToastNotification]::new($tpl))`;
    const p = exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 4000 });
    p.on("error", () => _fallbackPopup(title, body));
    p.on("exit", (code) => { if (code !== 0) _fallbackPopup(title, body); });
  } catch { _fallbackPopup(title, body); }
}
async function _fallbackPopup(title, body) {
  try {
    const { exec } = await import("node:child_process");
    const tidy = (s) => String(s).replace(/'/g, "''");
    exec(`powershell -NoProfile -Command "$wsh = New-Object -ComObject WScript.Shell; $null = $wsh.Popup('${tidy(title + '\n\n' + body)}', 8, 'gc2oc', 64)"`, { timeout: 8000 });
  } catch {}
}

async function checkVersion() {
  try {
    const fs = await import("node:fs");
    let local = ""; try { local = fs.readFileSync(VERSION_FILE, "utf8").replace(/[^\d]/g, ""); } catch {}

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let remote = "";
    try {
      const resp = await fetch(VERSION_API_URL, {
        signal: ctrl.signal,
        headers: { Accept: "application/vnd.github.v3+json" }
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json.content) {
          remote = Buffer.from(json.content, "base64").toString("utf8").replace(/[^\d]/g, "");
        }
      }
    } catch {}
    clearTimeout(t);

    if (remote && local === remote) {
      log("\x1b[32m[version] up to date\x1b[0m");
    } else if (remote && local !== remote) {
      log(`\x1b[31m[version] outdated (local=${local.slice(0,14)} remote=${remote.slice(0,14)})\x1b[0m`);
      setConsoleTitle("gc2oc (outdated, check github for new version)");
      showToast("gc2oc is outdated", "Check GitHub for the latest version"); // fire-and-forget
    } else {
      log(`\x1b[90m[version] no remote version\x1b[0m`);
    }
  } catch (e) {
    log(`\x1b[31m[version] check failed: ${e.message}\x1b[0m`);
  }
}

// ── Logging ──
const logReq = (c) => {
  if (!config.requestLog) return;
  const path = new URL(c.req.url).pathname;
  const ua = (c.req.header("User-Agent") || "none").slice(0, 120);
  const baggage = (c.req.header("baggage") || "none").slice(0, 160);
  const accept = (c.req.header("Accept") || "none").slice(0, 80);
  const xEditor = (c.req.header("x-editor-version") || c.req.header("X-Editor-Version") || "").slice(0, 60);
  const xVSSession = (c.req.header("x-vss-session-id") || "").slice(0, 40);
  const extras = [ua, baggage ? `baggage=${baggage}` : "", accept ? `accept=${accept}` : "", xEditor ? `editor=${xEditor}` : "", xVSSession ? `vss=${xVSSession}` : ""].filter(Boolean).join(" ");
  log(`${c.req.method} ${path} ${extras ? `| ${extras}` : ""}`);
};
const err = (msg) => logErr(msg);

// Auto-create .env if missing
(async () => {
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(".env")) {
      fs.writeFileSync(".env", "# OpenCode API key (optional — free models work without it)\n# Get yours at: https://opencode.ai\nOPENCODE_API_KEY=\n\n# Multi-key rotation (optional)\n# OPENCODE_API_KEYS=[\"key1\",\"key2\"]\n\n# Hide free models from the list (default false)\nHIDE_FREE=false\n\n# Show Pollinations free models (pol/ prefix) — true by default\nSHOW_POLL_MODELS=true\n\n# Hide Pollinations cosplay aliases (GPT-5, Claude, Gemini, DeepSeek, Llama-4, Mistral)\n# — true by default, shows only the real GPT-OSS 20B model. Set to false to show all 7.\nHIDE_POLL_COSPLAY=true\n\n# Log incoming requests (default true)\nREQUEST_LOG=true\n\n# ── Prompt Compression (OmniRoute RTK+Caveman stacked) ──\n# auto / off / lite / caveman / aggressive / ultra / rtk / stacked (default: auto)\n# auto picks: off for <=3 msgs, stacked for free/poll, caveman for paid\nCOMPRESSION_LEVEL=auto\n\n# ── DLP / Content Blocklist (ghcp-proxy enrichment) ──\n# Enable prompt content filtering (default false)\nBLOCKLIST_ENABLED=false\n\n# Blocklist mode: \"block\" (deny with 403) or \"report\" (allow but log)\nBLOCKLIST_MODE=block\n\n# Comma-separated keywords to block (case-insensitive)\n# BLOCKLIST_KEYWORDS=secret,confidential,password\n\n# Comma-separated file name patterns to block\n# BLOCKLIST_FILEPATTERNS=passwords.txt,.env.production\n\n# Comma-separated regex patterns to block\n# BLOCKLIST_REGEX=sk-[A-Za-z0-9]{20,}\n\n# ── Concurrency & Rate Limiting (antigravity-copilot enrichment) ──\n# Maximum concurrent requests for thinking models (keep low to avoid upstream 429s)\n# CONCURRENCY_THINKING=1\n\n# Maximum concurrent requests for standard models\n# CONCURRENCY_STANDARD=3\n\n# Retry attempts for 429 / RESOURCE_EXHAUSTED errors (0 to disable)\n# RETRY_MAX=3\n\n# Base delay before first retry in ms (exponential backoff follows)\n# RETRY_BASE_DELAY_MS=100\n\n# Abort thinking model requests after this many ms (prevents quota exhaustion)\n# THINKING_TIMEOUT_MS=60000\n\n# Abort standard model requests after this many ms\n# REQUEST_TIMEOUT_MS=120000\n\n# Truncate large tool outputs (e.g., git diff) to reduce context size\n# TRUNCATE_TOOL_OUTPUT=true\n\n# Max chars kept per tool output after truncation\n# MAX_TOOL_OUTPUT_CHARS=12000\n\n# Chars kept from start of tool output when truncating\n# TOOL_OUTPUT_HEAD_CHARS=6000\n\n# Chars kept from end of tool output when truncating\n# TOOL_OUTPUT_TAIL_CHARS=2000\n\n# Absolute max request body size in bytes (returns 413 if exceeded)\n# MAX_REQUEST_BODY_BYTES=10485760\n\n# ── User Auth (ghcp-proxy allowed_users pattern) ──\n# Comma-separated list of allowed users (Proxy-Authorization or X-User-ID header)\n# ALLOWED_USERS=dev1,dev2\n\n# ── Model metadata (lmstudio-ollama-proxy enrichment) ──\n# Force all models to report full capabilities (chat/completion/vision/tools/agent)\nFORCE_ALL_CAPABILITIES=true\n\n# Force a specific context length for all models (0 = use auto-detection)\n# FORCE_CONTEXT_LENGTH=131072\n\n# Default context length fallback when not available from models.dev\nDEFAULT_CONTEXT_LENGTH=131072\n\n# Per-model metadata overrides (JSON). Example:\n# MODEL_METADATA_JSON={\"my-model\":{\"context_length\":32768,\"capabilities\":[\"chat\",\"tools\"],\"family\":\"my-family\",\"parameter_size\":\"7B\"}}\n\n# Passthrough base URL — forward unmatched paths to this upstream\n# PASSTHROUGH_BASE_URL=https://opencode.ai/zen/go/v1\n# Passthrough path prefixes (comma-separated, default /v1)\n# PASSTHROUGH_PREFIXES=/v1,/api/v0\n");
      log("Created .env — add your OPENCODE_API_KEY there to unlock paid models");
    }
  } catch { /* fs not available, ignore */ }
})();

// No API key needed — free tier works without

const app = new Hono();

// CORS — VS Code Copilot sends requests from file:// / vscode-file:// origins
app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }));

// Response compression (gzip / deflate / brotli) — reduces wire bytes 70-90%
app.use(compress());

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

let _forceClient = null; // debug: ?src=vscode|vs|vsi|sql
let _detectedClient = null; // resolved client for logging

const isVSCode = (c) => {
  if (_forceClient) return _forceClient === "vscode";
  const ua = c.req.header("User-Agent") || "";
  return /GitHubCopilotChat\//i.test(ua);
};

const isVS2026 = (c) => {
  if (_forceClient) return _forceClient === "vs";
  const baggage = c.req.header("baggage") || "";
  return /vs\.copilot\./i.test(baggage);
};

const isVSInsiders = (c) => {
  if (_forceClient) return _forceClient === "vsi";
  const baggage = c.req.header("baggage") || "";
  return /VirtualAgentModeResponder/i.test(baggage);
};

const isSqlStudio = (c) => {
  if (_forceClient) return _forceClient === "sql";
  const baggage = c.req.header("baggage") || "";
  return /SSMSAgent/i.test(baggage);
};

function resolveClient(c) {
  const envClient = Bun.env.DEFAULT_CLIENT || "";
  if (envClient && ["vscode","vs","vsi","sql"].includes(envClient)) return envClient;
  if (isVSCode(c)) return "vscode";
  if (isVSInsiders(c)) return "vsi";
  if (isVS2026(c)) return "vs";
  if (isSqlStudio(c)) return "sql";
  return Bun.env.DEFAULT_CLIENT || "vscode"; // fallback or env default
}

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
// Primary: position-based FIFO (guarantees correct ordering per-request)
// Fallback: content/tool hash + model-key
const _assistantReasonings = []; // FIFO queue, populated per-AI-response
let _reasoningIndex = 0;          // cursor reset per-request
const reasoningCache = new Map(); // contentHash -> reasoningContent (hash fallback)
function _resetReasoning() { _reasoningIndex = 0; }
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
  _assistantReasonings.push(reasoning);
  if (_assistantReasonings.length > 50) _assistantReasonings.shift();
  const h = _msgHash(msg);
  if (h) reasoningCache.set(h, reasoning);
  reasoningCache.set(`mdl:${model}`, reasoning); // model-key fallback
}

function _getReasoning(msg, model) {
  // First try exact hash cache match
  const h = _msgHash(msg);
  if (h && reasoningCache.has(h)) return reasoningCache.get(h);
  // Position-based fallback (guarantees correct per-message ordering)
  if (_reasoningIndex < _assistantReasonings.length) {
    return _assistantReasonings[_reasoningIndex++];
  }
  return reasoningCache.get(`mdl:${model}`); // model-key fallback
}

// Ollama -> Go model mappings (what VS Copilot sends vs what Go API expects)
const MODEL_MAP = {};

function mapModel(name) {
  const parsed = parseThinkingMode(name);
  let clean = parsed.model.replace(":latest", "").split(":")[0].trim();
  clean = clean.replace(/^\s*\[(?:FREE_P|FREE|GO|M365|m365)\]\s*/i, "").trim();
  const mapped = MODEL_MAP[clean] || MODEL_MAP[clean.toLowerCase()];
  if (mapped) return mapped;
  return resolveModel(clean).id;
}

function getWorkspaceRoot(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    // VS Code Copilot: "workspace root path is: ..."
    const m2 = c.match(/workspace root path is:\s*(\S+)/i);
    if (m2) return m2[1].replace(/\\+$/, "").replace(/\\/g, "/");
    // VS 2026 Copilot: "Path to the workspace root: ..."
    const m3 = c.match(/path to (the )?workspace root:?\s*(\S+)/i);
    if (m3) return (m3[2] || m3[1] || "").replace(/\\+$/, "").replace(/\\/g, "/");
    // VS 2026: <CurrentWorkingDirectory>...</CurrentWorkingDirectory>
    const m4 = c.match(/<CurrentWorkingDirectory>\s*([^<]+)\s*<\/CurrentWorkingDirectory>/i);
    if (m4) return m4[1].trim().replace(/\\/g, "/");
    // VS 2026: file path at start of user message
    const m5 = c.match(/^([A-Za-z]:[\\/][^\n]+?)(?:\n|$)/);
    if (m5 && (m5[1].includes("\\") || m5[1].includes("/"))) {
      const p = m5[1].replace(/\\/g, "/");
      const dir = p.lastIndexOf("/");
      if (dir > 0) return p.substring(0, dir);
    }
  }
  return "";
}

function getActiveFile(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    // VS 2026: currently opened file
    const m2 = c.match(/currently opened file:?\s*(\S+)/i);
    if (m2) return m2[1].replace(/\\/g, "/");
    // VS Code: active file
    const m3 = c.match(/active file:?\s*(\S+)/i);
    if (m3) return m3[1].replace(/\\/g, "/");
  }
  return "";
}

function getSelectedCode(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    const m2 = c.match(/selected (?:code|text):?\s*\n?```[\w-]*\n?([\s\S]*?)```/i);
    if (m2) return m2[1].trim();
    const m3 = c.match(/<SelectedCode>([\s\S]*?)<\/SelectedCode>/i);
    if (m3) return m3[1].trim();
  }
  return "";
}

function extractVSContext(messages) {
  return {
    workspace_root: getWorkspaceRoot(messages),
    active_file: getActiveFile(messages),
    selected_code: getSelectedCode(messages),
  };
}

function _injectProjectUpdate(calls, messages, workspaceRoot) {
  // Reserved for future project file injection
}

const _schemaSeen = new Set();
function _dumpToolSchemas(tools) {
  if (!tools?.length) return;
  for (const t of tools) {
    const n = t.function?.name;
    if (!n || _schemaSeen.has(n)) continue;
    _schemaSeen.add(n);
    const summary = JSON.stringify({
      name: n,
      required: t.function?.parameters?.required,
      properties: t.function?.parameters?.properties ? Object.keys(t.function.parameters.properties) : undefined,
    });
    log(`\x1b[33m[schema] ${summary}\x1b[0m`);
  }
}

function normalizeToolCall(tc) {
  const name = tc.function?.name || "";
  try {
    const raw = tc.function.arguments || "{}";
    const args = JSON.parse(raw);
    const safe = {};

    // ── Confirmed VS schemas (VS Insiders 18.7) ──
    if (/^get_file$/i.test(name)) {
      // VS: required ["filename","startLine","endLine"]  properties: filename,startLine,endLine,includeLineNumbers
      safe.filename = String(args.filename ?? args.filePath ?? args.path ?? args.uri ?? args.resource ?? "");
      safe.startLine = (typeof args.startLine === "number" && args.startLine >= 1) ? args.startLine : 1;
      safe.endLine = (typeof args.endLine === "number" && args.endLine >= safe.startLine) ? args.endLine : 999999;
      if (typeof args.includeLineNumbers === "boolean") safe.includeLineNumbers = args.includeLineNumbers;
    } else if (/^read_file$/i.test(name)) {
      // VSCode: required ["filePath","startLine","endLine"]  properties: filePath,startLine,endLine
      safe.filePath = String(args.filePath ?? args.filename ?? args.path ?? args.uri ?? "");
      safe.startLine = (typeof args.startLine === "number" && args.startLine >= 1) ? args.startLine : 1;
      safe.endLine = (typeof args.endLine === "number" && args.endLine >= safe.startLine) ? args.endLine : 999999;
    } else if (/^(grep_search|search_content|search_file)$/i.test(name)) {
      // required: ["query","isRegexp","includePattern","maxResults"]  properties: query,isRegexp,includePattern,maxResults
      safe.query = String(args.query ?? args.pattern ?? args.search ?? args.searchTerm ?? "");
      safe.isRegexp = (typeof args.isRegexp === "boolean") ? args.isRegexp : (typeof args.regex === "boolean" ? args.regex : false);
      safe.includePattern = args.includePattern ?? args.include ?? args.fileTypes ?? args.glob ?? null;
      if (safe.includePattern !== null) safe.includePattern = String(safe.includePattern);
      safe.maxResults = (typeof args.maxResults === "number" && args.maxResults >= 1) ? args.maxResults : 20;
    } else if (/^replace_string_in_file$/i.test(name)) {
      // required: ["filePath","oldString","newString"]  properties: filePath,oldString,newString
      safe.filePath = String(args.filePath ?? args.path ?? args.filename ?? "");
      safe.oldString = String(args.oldString ?? args.old_str ?? args.search ?? args.old_text ?? "");
      safe.newString = String(args.newString ?? args.new_str ?? args.replace ?? args.new_text ?? "");
    } else if (/^multi_replace_string_in_file$/i.test(name)) {
      // required: ["replacements","explanation"]  properties: replacements,explanation
      const list = args.replacements ?? args.edits ?? args.changes ?? args.patches ?? args.operations ?? args.diffs;
      if (Array.isArray(list)) {
        safe.replacements = list.map(r => {
          const e = {};
          e.filePath = String(r.filePath ?? r.filepath ?? r.path ?? r.filename ?? "");
          e.oldString = String(r.oldString ?? r.old_str ?? r.search ?? r.old_text ?? r.find ?? r.from ?? "");
          e.newString = String(r.newString ?? r.new_str ?? r.replace ?? r.new_text ?? r.to ?? "");
          return e;
        });
      } else {
        const so = String(args.oldString ?? args.old_str ?? args.search ?? args.old_text ?? "");
        const sn = String(args.newString ?? args.new_str ?? args.replace ?? args.new_text ?? "");
        if (so || sn) safe.replacements = [{ filePath: "", oldString: so, newString: sn }];
      }
      safe.explanation = String(args.explanation ?? "");
    } else if (/^create_file$/i.test(name)) {
      // required: ["filePath","content"]  properties: filePath,content
      safe.filePath = String(args.filePath ?? args.path ?? args.filename ?? "");
      safe.content = String(args.content ?? args.contents ?? args.text ?? args.code ?? "");
    } else if (/^remove_file|delete_file(s)?$/i.test(name)) {
      // required: ["filePath"]  properties: filePath
      safe.filePath = String(args.filePath ?? args.path ?? args.filename ?? "");
    } else if (/^run_command_in_terminal|execute_command$/i.test(name)) {
      // required: ["command","summary","background"]  properties: command,summary,background
      safe.command = String(args.command ?? args.cmd ?? "");
      safe.summary = String(args.summary ?? args.description ?? "");
      safe.background = (typeof args.background === "boolean") ? args.background : (typeof args.runInBackground === "boolean" ? args.runInBackground : false);
    } else if (/^get_background_terminal_output$/i.test(name)) {
      // required: ["terminal_id","headLines","tailLines","stop","waitMs"]  properties: terminal_id,headLines,tailLines,stop,waitMs
      safe.terminal_id = String(args.terminal_id ?? args.terminalId ?? args.terminal ?? "");
      safe.headLines = (typeof args.headLines === "number") ? args.headLines : 0;
      safe.tailLines = (typeof args.tailLines === "number") ? args.tailLines : 0;
      safe.stop = (typeof args.stop === "boolean") ? args.stop : false;
      safe.waitMs = (typeof args.waitMs === "number") ? args.waitMs : (typeof args.timeout === "number" ? args.timeout : 0);
    } else if (/^(code_search|search_code|semantic_search)$/i.test(name)) {
      // required: ["searchQueries"]  properties: searchQueries
      safe.searchQueries = args.searchQueries ?? args.queries ?? args.query ?? args.search ?? [];
      if (!Array.isArray(safe.searchQueries)) safe.searchQueries = [String(safe.searchQueries ?? "")];
    } else if (/^(file_search|search_files|find_files|glob_search|list_files)$/i.test(name)) {
      // required: ["queries","maxResults"]  properties: queries,maxResults
      safe.queries = args.queries ?? args.query ?? args.pattern ?? [];
      if (!Array.isArray(safe.queries)) safe.queries = [String(safe.queries ?? "")];
      safe.maxResults = (typeof args.maxResults === "number" && args.maxResults >= 1) ? args.maxResults : 20;
    } else if (/^(get_files_in_project|list_project_files|get_project_files|list_files_in_project)$/i.test(name)) {
      // required: ["projectPath"]  properties: projectPath
      safe.projectPath = String(args.projectPath ?? args.projectName ?? args.project ?? args.name ?? args.project_name ?? "");
    } else if (/^(get_projects_in_solution)$/i.test(name)) {
      // required: []  properties: []
      // no-op — just return the safe empty object
    } else if (/^(run_build|build)$/i.test(name)) {
      // required: []  properties: []
      // no-op
    } else if (/^(run_tests|execute_tests)$/i.test(name)) {
      // required: ["filterTypes","filterValues"]  properties: filterTypes,filterValues
      safe.filterTypes = args.filterTypes ?? args.filter_types ?? [];
      if (!Array.isArray(safe.filterTypes)) safe.filterTypes = [String(safe.filterTypes ?? "")];
      safe.filterValues = args.filterValues ?? args.filter_values ?? args.testName ?? args.test ?? [];
      if (!Array.isArray(safe.filterValues)) safe.filterValues = [String(safe.filterValues ?? "")];
    } else if (/^(get_tests|list_tests|discover_tests)$/i.test(name)) {
      // required: ["filterTypes","filterValues"]  properties: filterTypes,filterValues
      safe.filterTypes = args.filterTypes ?? args.filter_types ?? [];
      if (!Array.isArray(safe.filterTypes)) safe.filterTypes = [String(safe.filterTypes ?? "")];
      safe.filterValues = args.filterValues ?? args.filter_values ?? args.filePath ?? args.projectName ?? [];
      if (!Array.isArray(safe.filterValues)) safe.filterValues = [String(safe.filterValues ?? "")];
    } else if (/^(get_errors|list_errors|get_diagnostics)$/i.test(name)) {
      // required: ["filePaths"]  properties: filePaths
      safe.filePaths = args.filePaths ?? args.filePath ?? [];
      if (!Array.isArray(safe.filePaths)) safe.filePaths = [String(safe.filePaths ?? "")];
    } else if (/^get_output_window_logs$/i.test(name)) {
      // required: ["paneId"]  properties: paneId
      safe.paneId = String(args.paneId ?? args.outputPane ?? args.pane ?? "");
    } else if (/^get_web_pages$/i.test(name)) {
      // required: ["urls"]  properties: urls
      safe.urls = args.urls ?? args.url ?? [];
      if (!Array.isArray(safe.urls)) safe.urls = [String(safe.urls ?? "")];
    } else if (/^(find_symbol|search_symbol)$/i.test(name)) {
      // Actual VS schema (live dump): required ["navigationType","filepath","symbolName","lineText"]
      // navigationType: 0=goToDefinition, 1=findReferences — must be integer, NOT string
      const q = String(args.query ?? args.symbolName ?? args.symbol ?? args.name ?? "");
      safe.symbolName = q;
      safe.navigationType = typeof args.navigationType === "number" ? args.navigationType
        : (typeof args.navType === "number" ? args.navType
        : (typeof args.type === "number" ? args.type : 1));
      safe.filepath = String(args.filepath ?? args.filePath ?? args.filename ?? "");
      safe.lineText = String(args.lineText ?? args.line ?? args.text ?? "");
    } else if (/^nuget_get_latest_package_version$/i.test(name)) {
      // required: ["solutionDirectory","packageName","includePrerelease"]  properties: solutionDirectory,packageName,includePrerelease
      safe.solutionDirectory = String(args.solutionDirectory ?? args.solution ?? "");
      safe.packageName = String(args.packageName ?? args.package ?? args.name ?? args.id ?? "");
      safe.includePrerelease = (typeof args.includePrerelease === "boolean") ? args.includePrerelease : false;
    } else if (/^nuget_get_package_context$/i.test(name)) {
      // required: ["solutionDirectory","packageName","packageVersion"]  properties: solutionDirectory,packageName,packageVersion
      safe.solutionDirectory = String(args.solutionDirectory ?? args.solution ?? "");
      safe.packageName = String(args.packageName ?? args.package ?? args.name ?? args.id ?? "");
      safe.packageVersion = String(args.packageVersion ?? args.version ?? "");
    } else if (/^nuget_upgrade_packages_to_latest$/i.test(name)) {
      // required: ["solutionDirectory","projectPaths","includeVulnerable","includePrerelease"]
      safe.solutionDirectory = String(args.solutionDirectory ?? args.solution ?? "");
      safe.projectPaths = args.projectPaths ?? args.projectPath ?? args.projectName ?? [];
      if (!Array.isArray(safe.projectPaths)) safe.projectPaths = [String(safe.projectPaths ?? "")];
      safe.includeVulnerable = (typeof args.includeVulnerable === "boolean") ? args.includeVulnerable : false;
      safe.includePrerelease = (typeof args.includePrerelease === "boolean") ? args.includePrerelease : false;
    } else if (/^nuget_fix_vulnerable_packages$/i.test(name)) {
      // required: ["solutionDirectory","projectPaths","includePrerelease"]
      safe.solutionDirectory = String(args.solutionDirectory ?? args.solution ?? "");
      safe.projectPaths = args.projectPaths ?? args.projectPath ?? args.projectName ?? [];
      if (!Array.isArray(safe.projectPaths)) safe.projectPaths = [String(safe.projectPaths ?? "")];
      safe.includePrerelease = (typeof args.includePrerelease === "boolean") ? args.includePrerelease : false;
    } else if (/^(plan)$/i.test(name)) {
      // required: ["planMarkdown"]  properties: planMarkdown
      safe.planMarkdown = String(args.planMarkdown ?? args.task ?? args.plan ?? "");
    } else if (/^(adapt_plan)$/i.test(name)) {
      // required: ["observation"]  properties: observation
      safe.observation = String(args.observation ?? args.changes ?? args.note ?? "");
    } else if (/^(update_plan_progress)$/i.test(name)) {
      // required: ["stepId","status","message","autoAdvance"]  properties: stepId,status,message,autoAdvance
      safe.stepId = String(args.stepId ?? args.step ?? "");
      safe.status = String(args.status ?? "in_progress");
      safe.message = String(args.message ?? "");
      safe.autoAdvance = (typeof args.autoAdvance === "boolean") ? args.autoAdvance : true;
    } else if (/^(record_observation)$/i.test(name)) {
      // required: ["observation"]  properties: observation
      safe.observation = String(args.observation ?? args.note ?? args.finding ?? "");
    } else if (/^(finish_plan)$/i.test(name)) {
      // required: []  properties: []
      // no-op
    } else if (/^(signal_plan_ready)$/i.test(name)) {
      // required: ["planTitle"]  properties: planTitle
      safe.planTitle = String(args.planTitle ?? args.title ?? args.name ?? "");
    } else if (/^(clarify_requirements)$/i.test(name)) {
      // required: ["questions"]  properties: questions
      safe.questions = args.questions ?? args.question ?? [];
      if (!Array.isArray(safe.questions)) safe.questions = [String(safe.questions ?? "")];
    } else if (/^(detect_memories)$/i.test(name)) {
      // required: ["memory","confidence"]  properties: memory,confidence
      safe.memory = String(args.memory ?? args.query ?? args.text ?? "");
      safe.confidence = (typeof args.confidence === "number") ? args.confidence : 0.5;
    } else if (/^(profiler_agent)$/i.test(name)) {
      // required: ["reason"]  properties: reason
      safe.reason = String(args.reason ?? args.prompt ?? args.query ?? args.question ?? "");
    } else if (/^(start_modernization|task_complete)$/i.test(name)) {
      // required: []  properties: []
      // no-op
    } else if (/^(query_azure_resource_graph)$/i.test(name)) {
      // required: ["prompt"]  properties: prompt
      safe.prompt = String(args.prompt ?? args.query ?? "");
    } else if (/^(run_subagent)$/i.test(name)) {
      // required: ["prompt","description","agentName"]  properties: prompt,description,agentName
      safe.prompt = String(args.prompt ?? args.task ?? "");
      safe.description = String(args.description ?? args.desc ?? "");
      safe.agentName = String(args.agentName ?? args.agent ?? args.name ?? "");
    } else if (/^(search_agent)$/i.test(name)) {
      // required: ["query","description","details"]  properties: query,description,details
      safe.query = String(args.query ?? args.search ?? "");
      safe.description = String(args.description ?? args.desc ?? "");
      safe.details = String(args.details ?? args.info ?? "");
    } else if (/^Azure_MCP_Server_/i.test(name)) {
      if (args.intent != null) safe.intent = String(args.intent);
      if (args.command != null) safe.command = String(args.command);
      if (args.parameters != null) safe.parameters = args.parameters;
      if (args.learn != null) safe.learn = String(args.learn);
      if (args.tenant != null) safe.tenant = String(args.tenant);
      if (args.subscription != null) safe.subscription = String(args.subscription);
      if (args["resource-group"] != null) safe["resource-group"] = String(args["resource-group"]);
      if (args["cli-type"] != null) safe["cli-type"] = String(args["cli-type"]);
      if (args["auth-method"] != null) safe["auth-method"] = String(args["auth-method"]);
      if (args["retry-delay"] != null) safe["retry-delay"] = String(args["retry-delay"]);
      if (args["retry-max-delay"] != null) safe["retry-max-delay"] = String(args["retry-max-delay"]);
      if (typeof args["retry-max-retries"] === "number") safe["retry-max-retries"] = args["retry-max-retries"];
      if (args["retry-mode"] != null) safe["retry-mode"] = String(args["retry-mode"]);
      if (args["retry-network-timeout"] != null) safe["retry-network-timeout"] = String(args["retry-network-timeout"]);
    // ── VSCode Copilot tools ──
    } else if (/^list_dir$/i.test(name)) {
      // required: ["path"]  properties: path
      safe.path = String(args.path ?? args.dirPath ?? "");
    } else if (/^create_directory$/i.test(name)) {
      // required: ["dirPath"]  properties: dirPath
      safe.dirPath = String(args.dirPath ?? args.path ?? "");
    } else if (/^insert_edit_into_file$/i.test(name)) {
      // required: ["explanation","filePath","code"]  properties: explanation,filePath,code
      safe.explanation = String(args.explanation ?? "");
      safe.filePath = String(args.filePath ?? args.path ?? args.filename ?? "");
      safe.code = String(args.code ?? args.content ?? args.text ?? "");
    } else if (/^(run_in_terminal|send_to_terminal)$/i.test(name)) {
      // run_in_terminal: required ["command","explanation","goal","mode"]  send_to_terminal: required ["id","command"]
      safe.command = String(args.command ?? args.cmd ?? "");
      if (args.id != null) safe.id = String(args.id);
      if (args.explanation != null) safe.explanation = String(args.explanation);
      if (args.goal != null) safe.goal = String(args.goal);
      if (args.mode != null) safe.mode = String(args.mode);
      if (typeof args.isBackground === "boolean") safe.isBackground = args.isBackground;
      if (typeof args.timeout === "number") safe.timeout = args.timeout;
      if (typeof args.waitForOutput === "boolean") safe.waitForOutput = args.waitForOutput;
    } else if (/^get_terminal_output$/i.test(name)) {
      // required: ["id"]  properties: id
      safe.id = String(args.id ?? args.terminal_id ?? "");
    } else if (/^kill_terminal$/i.test(name)) {
      // required: ["id"]  properties: id
      safe.id = String(args.id ?? args.terminal_id ?? "");
    } else if (/^semantic_search$/i.test(name)) {
      // required: ["query"]  properties: query
      safe.query = String(args.query ?? args.search ?? "");
    } else if (/^fetch_webpage$/i.test(name)) {
      // required: ["urls","query"]  properties: urls,query
      safe.urls = args.urls ?? args.url ?? [];
      if (!Array.isArray(safe.urls)) safe.urls = [String(safe.urls ?? "")];
      safe.query = String(args.query ?? "");
    } else if (/^runSubagent$/i.test(name)) {
      // required: ["prompt","description"]  properties: prompt,description,agentName,model
      safe.prompt = String(args.prompt ?? args.task ?? "");
      safe.description = String(args.description ?? args.desc ?? "");
      if (args.agentName != null) safe.agentName = String(args.agentName);
      if (args.model != null) safe.model = String(args.model);
    } else if (/^manage_todo_list$/i.test(name)) {
      // required: ["todoList"]  properties: todoList
      safe.todoList = args.todoList ?? args.todos ?? [];
      if (!Array.isArray(safe.todoList)) safe.todoList = [safe.todoList];
    } else if (/^memory$/i.test(name)) {
      // required: ["command"]  properties: command,path,file_text,old_str,new_str,...
      safe.command = String(args.command ?? "");
      if (args.path != null) safe.path = String(args.path);
      if (args.file_text != null) safe.file_text = String(args.file_text);
      if (args.old_str != null) safe.old_str = String(args.old_str);
      if (args.new_str != null) safe.new_str = String(args.new_str);
      if (typeof args.insert_line === "number") safe.insert_line = args.insert_line;
      if (args.insert_text != null) safe.insert_text = String(args.insert_text);
      if (args.view_range != null) safe.view_range = args.view_range;
      if (args.old_path != null) safe.old_path = String(args.old_path);
      if (args.new_path != null) safe.new_path = String(args.new_path);
    } else if (/^vscode_listCodeUsages$/i.test(name)) {
      // required: ["symbol","lineContent"]  properties: symbol,uri,filePath,lineContent
      safe.symbol = String(args.symbol ?? args.symbolName ?? args.query ?? "");
      safe.lineContent = String(args.lineContent ?? args.line ?? "");
      if (args.filePath != null) safe.filePath = String(args.filePath);
      if (args.uri != null) safe.uri = String(args.uri);
    } else if (/^vscode_renameSymbol$/i.test(name)) {
      // required: ["symbol","newName","lineContent"]  properties: symbol,newName,uri,filePath,lineContent
      safe.symbol = String(args.symbol ?? "");
      safe.newName = String(args.newName ?? args.new_name ?? "");
      safe.lineContent = String(args.lineContent ?? args.line ?? "");
      if (args.filePath != null) safe.filePath = String(args.filePath);
      if (args.uri != null) safe.uri = String(args.uri);
    } else if (/^vscode_askQuestions$/i.test(name)) {
      // required: ["questions"]  properties: questions
      safe.questions = args.questions ?? args.question ?? [];
      if (!Array.isArray(safe.questions)) safe.questions = [String(safe.questions ?? "")];
    } else if (/^run_vscode_command$/i.test(name)) {
      // required: ["commandId","name"]  properties: commandId,name,args,skipCheck
      safe.commandId = String(args.commandId ?? args.command ?? "");
      safe.name = String(args.name ?? "");
      if (args.args != null) safe.args = args.args;
      if (typeof args.skipCheck === "boolean") safe.skipCheck = args.skipCheck;
    } else if (/^(create_and_run_task)$/i.test(name)) {
      // required: ["task","workspaceFolder"]  properties: workspaceFolder,task
      safe.task = String(args.task ?? "");
      safe.workspaceFolder = String(args.workspaceFolder ?? args.workspace ?? "");
    } else if (/^github_text_search$/i.test(name)) {
      // required: ["scope","query"]  properties: scope,query,maxResults
      safe.scope = String(args.scope ?? "repo");
      safe.query = String(args.query ?? args.search ?? "");
      if (typeof args.maxResults === "number") safe.maxResults = args.maxResults;
    } else if (/^github_repo$/i.test(name)) {
      // required: ["repo","query"]  properties: repo,query
      safe.repo = String(args.repo ?? "");
      safe.query = String(args.query ?? "");
    } else if (/^(open_browser_page|read_page|navigate_page|click_element|type_in_page|hover_element|drag_element|handle_dialog|screenshot_page|run_playwright_code)$/i.test(name)) {
      // VSCode browser/Playwright tools — pass all known params through
      for (const [k, v] of Object.entries(args)) {
        if (v != null) safe[k] = v;
      }
    } else if (/^lookup_vs$/i.test(name)) {
      // required: ["terms"]  properties: terms
      const rawTerms = args.terms ?? args.query ?? args.queries ?? args.search ?? args.searchTerms ?? "";
      safe.terms = Array.isArray(rawTerms) ? rawTerms.map(String) : [String(rawTerms)];
    } else {
      return tc;
    }

    const fixed = JSON.stringify(safe);
    return { ...tc, function: { ...tc.function, arguments: fixed } };
  } catch {}
  return tc;
}

function extractToolCalls(text, workspaceRoot = "", messages = []) {
  if (!text) return { content: text || "", toolCalls: [] };
  const calls = [];
  let remaining = text;

  // 0. Detect VS context from messages for better path resolution
  const vsCtx = workspaceRoot ? { workspace_root: workspaceRoot } : extractVSContext(messages);

  // 1. Explicit ```tool blocks
  const toolBlockRe = /```tool\n(\{[\s\S]*?\})\n```/g;
  let tb;
  while ((tb = toolBlockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(tb[1]);
      const tc = normalizeToolCall({
        id: callId(), type: "function",
        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
      });
      calls.push(tc);
      remaining = remaining.replace(tb[0], "");
    } catch {}
  }

  // 2. VS Copilot <function_calls> XML blocks
  const fcBlockRe = /<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/g;
  let fc;
  while ((fc = fcBlockRe.exec(text)) !== null) {
    const inner = fc[1];
    const invokeRe = /<invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
    let inv;
    while ((inv = invokeRe.exec(inner)) !== null) {
      const fnName = inv[1];
      const fnBody = inv[2];
      const args = {};
      const paramRe = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
      let p;
      while ((p = paramRe.exec(fnBody)) !== null) {
        args[p[1]] = p[2];
      }
      const tc = normalizeToolCall({
        id: callId(), type: "function",
        function: { name: fnName, arguments: JSON.stringify(args) },
      });
      if (tc) calls.push(tc);
    }
    remaining = remaining.replace(fc[0], "");
  }

  // 3. Markdown file creation: ## `path` ```lang\ncontent\n```
  const createRe = /(?:^|\n)(?:##\s*)?`([^`\n]+\.\w+)`\s*\n```[\w-]*\n([\s\S]*?)```/gi;
  let m;
  while ((m = createRe.exec(text)) !== null) {
    let fp = m[1].replace(/\\/g, "/").trim();
    const codeContent = m[2].trim();
    if (!fp || codeContent.length < 3 || codeContent.length > 200000) continue;
    // Skip project files — VS 2026 handles these natively
    if (/\.(csproj|vbproj|fsproj|jsproj|sln|xproj|dcproj|vcxproj|wsproj|njsproj)$/i.test(fp)) continue;
    if (vsCtx.workspace_root && !/^[A-Za-z]:[/\\]/.test(fp)) {
      fp = vsCtx.workspace_root.replace(/\/$/, "") + "/" + fp;
    }
    calls.push({
      id: callId(), type: "function",
      function: { name: "create_file", arguments: JSON.stringify({ filePath: fp, content: codeContent }) },
    });
  }

  // Auto-inject project file update for created files
  _injectProjectUpdate(calls, messages, vsCtx.workspace_root);

  if (calls.length === 0) return { content: text, toolCalls: [] };
  return { content: remaining.replace(/\n{3,}/g, "\n\n").trim(), toolCalls: calls };
}

// ── Debug client override (?src=vscode|vs|vsi|sql) ──
app.use("*", async (c, next) => {
  const src = c.req.query("src");
  if (src && ["vscode", "vs", "vsi", "sql"].includes(src)) {
    _forceClient = src;
    log(`\x1b[35m[debug]\x1b[0m src=${src}`);
  }
  await next();
  _forceClient = null;
});



// ── GET endpoints ──

app.get("/", c => c.json({ service: "gc2oc", status: "running" }));

app.get("/health", async c => {
  try {
    const models = await getModels();
    const real = models.filter(m => !isSeparator(m.model));
    const free = real.filter(m => isFreeTierModel(m.model));
    const paid = real.filter(m => !isFreeTierModel(m.model));
    const modelNames = real.flatMap(m => {
      const rawId = (m.model || "").replace(":latest", "").split(":")[0].trim();
      const modes = getThinkingModes(rawId);
      if (modes.length > 0) return [m.name, ...modes.map(mode => `${m.name} [${mode}]`)];
      return [m.name];
    }).sort();

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
    if (!config.showPollModels && isPollModel(m.model)) continue;
    const id = m.model.replace(":latest", "");
    const rawId = id.split(":")[0].trim();
    if (seen.has(rawId)) continue;
    seen.add(rawId);

    const isFree = isFreeTierModel(m.model);
    const isPoll = isPollModel(m.model);
    const isM365 = isM365Model(m.model);
    const prefix = isM365 ? "[m365] " : (isPoll ? "[FREE_P] " : (isFree ? "[FREE] " : "[GO] "));
    const family = m.details?.family || rawId;
    const metadata = resolveModelMetadata(rawId);
    const caps = metadata.capabilities || [];
    const ctxLen = metadata.context_length || config.defaultContextLength;
    const thinkingModes = sep ? [] : getThinkingModes(rawId);

    function thin(name) {
      if (vsc) return name;
      return name.length > 20 ? name.replace(/ /g, "\u2009") : name;
    }

    const SHORT_TAG = { LOW: "LO", MEDIUM: "MD", HIGH: "HI", MAXIMUM: "MX", XHIGH: "X" };

    function vsTag(baseName, mode) {
      if (vsc) return ` [${mode}]`;
      const full = ` [${mode}]`;
      if ((baseName + full).length <= 20) return full;
      const short = SHORT_TAG[mode];
      if (short) return ` [${short}]`;
      return full;
    }

    const VSC_TAG = { LOW: "/1_(low)", MEDIUM: "/2_(medium)", HIGH: "/3_high", MAXIMUM: "/4_(maximum)", XHIGH: "/4_(xhigh)" };

    function pushModel(name, modelTag, digestSuffix, parentModel) {
      const displayFamily = family + (modelTag || "");
      models.push({
        name: thin(name),
        model: `${vsc ? id + modelTag : m.model + modelTag}`,
        modified_at: now,
        size: m.size || 0,
        digest: m.digest ? `${m.digest}${digestSuffix}` : `${rawId}${digestSuffix}`,
        maxParams: m.maxParams || 0,
        capabilities: caps,
        context_length: ctxLen,
        max_output_tokens: 4096,
        pricing: isM365 ? "m365" : (isPoll ? "free_poll" : (isFree ? "free" : "premium")),
        details: {
          parent_model: parentModel || (m.details?.parent_model || ""),
          format: m.details?.format || "gguf",
          ...(sep ? {} : { family: displayFamily }),
          ...(sep ? {} : { families: [displayFamily] }),
          parameter_size: sep ? "" : (m.details?.parameter_size || ""),
          quantization_level: m.details?.quantization_level || "F16",
        },
      });
    }

    if (thinkingModes.length > 0) {
      const baseName = vsc ? prefix + m.name : m.name;
      pushModel(baseName, "", "", "");
      for (const mode of thinkingModes) {
        const tag = vsTag(baseName, mode);
        pushModel(
          `${baseName}${tag}`,
          vsc ? (VSC_TAG[mode] || `/${mode.toLowerCase()}`) : ` [${mode}]`,
          `-${mode.toLowerCase()}`,
          baseName,
        );
      }
    } else {
      pushModel(vsc ? prefix + m.name : m.name, "", "", "");
    }
  }

  const realCount = models.filter(m => !isSeparator(m.model)).length;
  const divCount = models.length - realCount;
  const clientTag = _forceClient || (isVSCode(c) ? "vscode" : isVS2026(c) ? "vs" : "generic");
  const srcTag = `[\x1b[35m${clientTag}\x1b[0m] `;
  log(`${srcTag}/api/tags → ${realCount} models${divCount > 0 ? ` (+${divCount} dividers)` : ""}`);
  return c.json({ models });
}

app.get("/api/version", c => c.json({ version: "420.96.00" }));

app.get("/version", async c => {
  const models = await getModels();
  const real = models.filter(m => !isSeparator(m.model)).flatMap(m => {
    const rawId = (m.model || "").replace(":latest", "").split(":")[0].trim();
    const modes = isSeparator(m.model) ? [] : getThinkingModes(rawId);
    if (modes.length > 0) return [m.name, ...modes.map(mode => `${m.name} [${mode}]`)];
    return [m.name];
  }).sort();
  return c.json({
    proxy_version: "420.96.00",
    ollama_compatibility: "0.6.4",
    proxy_name: "gc2oc",
    supported_models: real,
  });
});

let _lastRefresh = 0;
app.get("/api/ps", async c => {
  const vsc = isVSCode(c);
  const allModels = await getModels();
  const real = allModels.filter(m => !isSeparator(m.model));
  const models = [];
  for (const m of real) {
    const rawId = m.model.replace(":latest", "").split(":")[0].trim();
    const metadata = resolveModelMetadata(rawId);
    const thinkingModes = getThinkingModes(rawId);
    function psPush(name, suffix) {
      models.push({
        name: name + suffix,
        model: (m.model.replace(":latest", "") + suffix) || rawId,
        size: metadata.size || 0,
        digest: (m.digest || rawId) + (suffix ? suffix.toLowerCase() : ""),
        details: {
          parent_model: suffix ? name : "",
          format: "gguf",
          family: metadata.family + suffix,
          families: [(metadata.family + suffix)],
          parameter_size: metadata.parameter_size,
          quantization_level: metadata.quantization_level || "F16",
        },
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        size_vram: metadata.size_vram || 0,
        context_length: metadata.context_length,
      });
    }
    psPush(m.name, "");
    if (thinkingModes.length > 0) {
      for (const mode of thinkingModes) {
        psPush(m.name, ` [${mode}]`);
      }
    }
  }
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

// ── Force model refresh endpoint (like wienans refreshModels command) ──
app.post("/api/refresh", async c => {
  log("Force model refresh requested");
  const start = Date.now();
  await refreshModels();
  const models = await getModels();
  const real = models.filter(m => !isSeparator(m.model));
  return c.json({
    status: "refreshed",
    elapsed_ms: Date.now() - start,
    model_count: real.length,
    models: real.map(m => m.name).sort(),
  });
});

// ── Diagnostics / self-test endpoint (like wienans selfTest command) ──
app.post("/api/diagnostics", async c => {
  const body = await getBody(c);
  const testModel = body.model || config.defaultModel;
  const testModelId = mapModel(testModel);
  const info = resolveModel(testModelId);
  const metadata = resolveModelMetadata(testModelId);

  const results = {
    proxy: "gc2oc",
    version: "420.96.00",
    timestamp: new Date().toISOString(),
    authenticated: config.hasKey,
    concurrency_manager: ModelConcurrencyManager.getInstance().getStats(),
    models_cached: (await getModels()).filter(m => !isSeparator(m.model)).length,
  };

  const diagnostics = {
    connectivity: { status: "unknown", latency_ms: 0, error: null },
    streaming: { status: "unknown", chunks: 0, error: null },
    tool_calling: { status: "unknown", tool_calls: 0, error: null },
    model_info: {
      id: info.id,
      name: info.name,
      family: metadata.family,
      context_length: metadata.context_length,
      capabilities: metadata.capabilities,
      is_free: isFreeTierModel(testModelId),
    },
  };

  // Step 1: Connectivity check
  try {
    const start = Date.now();
    const cm = ModelConcurrencyManager.getInstance();
    const toolDef = {
      type: "function",
      function: {
        name: "diagnostics_get_time",
        description: "Returns the current server time",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    };
    const req = {
      model: testModelId,
      messages: [
        { role: "system", content: compactIdentity(testModelId) + "\nRun a diagnostics check. Call the diagnostics_get_time tool exactly once." },
        { role: "user", content: "Run diagnostics: call the provided tool exactly once and respond with 'Diagnostics OK' plus the tool result." },
      ],
      tools: [toolDef],
      stream: true,
    };

    let fullText = "";
    let chunkCount = 0;
    let allToolCalls = [];
    let hasToolCalls = false;
    let reasoningContent = null;
    const tcBuilders = new Map();

    await cm.acquireModel(testModelId);
    try {
      for await (const chunk of chatCompletion(req)) {
        const msg = chunk.message;
        if (!msg) continue;
        chunkCount++;

        if (msg.content) fullText += msg.content;
        if (msg.reasoning_content) reasoningContent = msg.reasoning_content;
        if (msg.reasoning) reasoningContent = msg.reasoning;

        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
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
    } finally {
      cm.releaseModel(testModelId);
    }

    allToolCalls = [...tcBuilders.values()];
    hasToolCalls = allToolCalls.length > 0;

    diagnostics.connectivity = { status: "ok", latency_ms: Date.now() - start, error: null };
    diagnostics.streaming = { status: "ok", chunks: chunkCount, error: null };
    diagnostics.tool_calling = { status: hasToolCalls ? "ok" : "not_detected", tool_calls: allToolCalls.length, error: null };

    if (fullText) {
      diagnostics.response_sample = fullText.slice(0, 300);
    }
    if (reasoningContent) {
      diagnostics.reasoning = reasoningContent.slice(0, 300);
    }
    if (hasToolCalls) {
      diagnostics.tool_calling.tools_called = allToolCalls.map(tc => ({
        name: tc.function.name,
        call_id: tc.id,
        args_preview: (tc.function.arguments || "").slice(0, 200),
      }));
    }

    results.status = "ok";
    if (!hasToolCalls) {
      results.status = "degraded";
      diagnostics.tool_calling.error = "No tool calls detected — check model capabilities";
    }
  } catch (e) {
    diagnostics.connectivity = { status: "failed", latency_ms: 0, error: e.message };
    diagnostics.streaming = { status: "skipped", chunks: 0, error: "connectivity failed" };
    diagnostics.tool_calling = { status: "skipped", tool_calls: 0, error: "connectivity failed" };
    results.status = "failed";
    results.error = e.message;
  }

  results.diagnostics = diagnostics;
  return c.json(results);
});

// ── OpenAI-compatible v1 endpoints (VS Copilot uses these) ──

function inferPromptCaching(modelId) {
  const lower = (modelId || "").toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gpt-4") || lower.includes("gpt-5") || lower.includes("o3") || lower.includes("o4") || lower.includes("o1")) return "openai";
  if (lower.includes("gemini")) return "google";
  return "none";
}

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
    if (!config.showPollModels && isPollModel(m.model)) continue;
    const rawId = m.model.replace(":latest", "").split(":")[0].trim();
    const isFree = isFreeTierModel(m.model);
    const isPoll = isPollModel(m.model);
    const isM365 = isM365Model(m.model);
    const prefix = isM365 ? "[m365] " : (isPoll ? "[FREE_P] " : (isFree ? "[FREE] " : "[GO] "));
    const id = vsc ? prefix + m.name : m.name;
    const metadata = resolveModelMetadata(rawId);
    const family = metadata.family;
    const caps = metadata.capabilities || [];
    const supportsTools = caps.includes("tools") || caps.includes("agent") || (m.supports_tools ?? true);
    const ctxLen = metadata.context_length || config.defaultContextLength;
    const maxPrompt = Math.min(ctxLen - 4096, ctxLen);
    const thinkingModes = getThinkingModes(rawId);

    function thin(name) {
      if (vsc) return name;
      return name.length > 20 ? name.replace(/ /g, "\u2009") : name;
    }

    const SHORT_TAG = { LOW: "LO", MEDIUM: "MD", HIGH: "HI", MAXIMUM: "MX", XHIGH: "X" };

    function vsTag(baseName, mode) {
      if (vsc) return ` [${mode}]`;
      const full = ` [${mode}]`;
      if ((baseName + full).length <= 20) return full;
      const short = SHORT_TAG[mode];
      if (short) return ` [${short}]`;
      return full;
    }

    function pushV1Model(name, idSuffix) {
      data.push({
        id: `${id}${idSuffix}`,
        object: "model",
        created: nowTs,
        owned_by: "OpenCode",
        name: thin(name),
        model_picker_enabled: isPickerEnabled(rawId),
        version: `${family.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}`,
        capabilities: {
          object: "model_capabilities",
          supports: {
            tool_calls: supportsTools,
            parallel_tool_calls: supportsTools,
            vision: caps.includes("vision"),
            agent: caps.includes("agent"),
            streaming: true,
            prompt_caching: caps.includes("tools") || caps.includes("agent"),
            prompt_caching_type: inferPromptCaching(rawId),
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
        pricing: isM365 ? "m365" : (isPoll ? "free_poll" : (isFree ? "free" : "premium")),
        context_length: ctxLen,
        max_output_tokens: 4096,
      });
    }

    if (thinkingModes.length > 0) {
      pushV1Model(name, "");
      for (const mode of thinkingModes) {
        const tag = vsTag(name, mode);
        pushV1Model(`${name}${tag}`, ` [${mode}]`);
      }
    } else {
      pushV1Model(name, "");
    }
  }

  const realCount = data.filter(m => !isSeparator(m.id)).length;
  const clientTag = _forceClient || (isVSCode(c) ? "vscode" : isVS2026(c) ? "vs" : "generic");
  log(`[\x1b[35m${clientTag}\x1b[0m] /v1/models → ${realCount} models`);
  return c.json({ object: "list", data });
});

app.post("/v1/chat/completions", async c => {
  const rawBody = await getBody(c);
  const body = normalizeOpenAIParams(rawBody);
  const rawModel = body.model || config.defaultModel;
  const modelParse = parseThinkingMode(rawModel);
  const model = modelParse.model;
  const thinkingTag = modelParse.thinking;
  const messages = body.messages || [];
  const clientWantsStream = body.stream === true;
  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);
  const vsInsiders = isVSInsiders(c);
  const mea = isSqlStudio(c);
  let clientTag = "";
  if (messages?.length) {
    for (const m of messages) {
      let raw = typeof m.content === "string" ? m.content.trim() : "";
      if (Array.isArray(m.content)) raw = m.content.map(p => (p?.text || p?.content || "").trim()).join("\n");
      const c = raw.toLowerCase();
      if (c.startsWith("## [lp]") || c.startsWith("## [pilot]") || c.startsWith("## task") || c.includes("[lp]") || c.includes("</task_type>") || c.includes("</instruction>")) { clientTag = "lp"; break; }
      const vsEnv = raw.match(/visual\s+studio\s+(enterprise|professional|community)?\s*\d{4}\s*\((\d+\.\d+\.\d+)(-insiders)?\)/i);
      if (vsEnv) {
        const edition = vsEnv[1] ? `_${vsEnv[1].toLowerCase().slice(0, 1)}` : "";
        const version = vsEnv[2];
        clientTag = vsEnv[3] ? `vsi${edition}-${version}` : `vs${edition}-${version}`;
        break;
      }
    }
  }
  if (!clientTag) {
    clientTag = mea ? "sql" : (vsInsiders ? "vsi" : (vs2026 ? "vs" : (vsc ? "vscode" : "")));
  }
  const streamMode = (vs2026 || vsInsiders || (clientTag && clientTag !== "vscode" && /^vs/.test(clientTag))) ? false : clientWantsStream;
  const vsTools = body.tools;
  _dumpToolSchemas(vsTools);
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

    // ── M365 Copilot path (no tools, no streaming via Go API) ──
    if (isM365Model(goModel)) {
      const m365Messages = messages.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map(p => p.text || "").join("") : ""),
      }));

      const lastMsg = m365Messages[m365Messages.length - 1];
      const preview = typeof lastMsg?.content === "string" ? lastMsg.content.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      const logDone = config.requestLog ? reqLog({ tag: clientTag, provider: "m365", model, thinking: thinkingTag, preview: `${preview}${(lastMsg?.content?.length || 0) > 60 ? "\u2026" : ""}` }) : null;
      const m365t0 = Date.now();

      if (streamMode) {
        return stream(c, async (s) => {
          const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
          const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
          await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          try {
            let fullText = "";
            for await (const chunk of m365ChatCompletionStream(goModel, m365Messages)) {
              fullText += chunk;
              await w({ ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
            }
            await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
            await s.write("data: [DONE]\n\n");
            logDone?.(Date.now() - m365t0);
          } catch (e) {
            err(`  m365 stream error: ${e.message}`);
            await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
            await s.write("data: [DONE]\n\n");
          }
        });
      }

      // Non-streaming
      try {
        const content = await m365ChatCompletion(goModel, m365Messages);

        // Simulate SSE streaming for clients that requested it (e.g. VS 2026 sends stream:true)
        if (clientWantsStream) {
          return stream(c, async s => {
            const w2 = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
            const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
            await w2({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            await _simStream(w2, base, false, null, content, null);
            await s.write("data: [DONE]\n\n");
            logDone?.(Date.now() - m365t0);
          });
        }

        logDone?.(Date.now() - m365t0);
        return c.json(oaiResp(content, undefined, "stop", model));
      } catch (e) {
        err(`  m365 error: ${e.message}`);
        const status = e instanceof M365CopilotError ? 502 : 500;
        return c.json({ error: { message: e.message, type: status === 502 ? "server_error" : "server_error", code: "m365_error" } }, status);
      }
    }

    let toolFailStreak = 0;
    let toolLoopBroken = false;
    _resetReasoning(); // position-based reasoning cache cursor
    for (const m of messages) {
      const role = (m.role || "").toLowerCase().trim();
      if (role === "system") {
        systemMsg += (systemMsg ? "\n" : "") + (typeof m.content === "string" ? m.content : "");
      } else if (role === "assistant") {
          // After 3+ consecutive tool errors, drop retry attempts
          if (toolLoopBroken && m.tool_calls?.length) continue;
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
        // LocalPilot sends tool msgs without proper tool_calls predecessor — validate and drop orphans
        if (clientTag === "lp") {
          const hasPrevToolCalls = userMsgs.length > 0 && userMsgs[userMsgs.length - 1].role === "assistant" && userMsgs[userMsgs.length - 1].tool_calls?.length;
          if (!hasPrevToolCalls) {
            log("  [lp] dropping orphan tool message (no preceding tool_calls)");
            continue;
          }
        }
        let tc = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
        // Terminal fallback: execute commands server-side when VS terminal is unavailable
        if (config.terminalFallback !== false && /Failed to find a valid Visual Studio terminal/i.test(tc)) {
          const callId = m.tool_call_id;
          const lastMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : null;
          if (lastMsg?.role === "assistant" && lastMsg?.tool_calls) {
            const matchingCall = lastMsg.tool_calls.find(c => c.id === callId && /^(run_command_in_terminal|execute_command)$/i.test(c.function?.name));
            if (matchingCall) {
              try {
                const callArgs = typeof matchingCall.function.arguments === "string" ?
                  JSON.parse(matchingCall.function.arguments) : (matchingCall.function.arguments || {});
                const cmdRaw = String(callArgs.command || callArgs.cmd || "");
                let cmd = cmdRaw;
                if (cmd) {
                  // Auto-fix: replace pwsh with powershell (pwsh/PS Core may not be installed)
                  cmd = cmd.replace(/^pwsh(\.exe)?(\s+-)/i, "powershell$2");
                  const cwd = callArgs.cwd || process.cwd();
                  const { exec } = await import("node:child_process");
                  log(`[term] proxy-exec: ${cmd}`);
                  // Wrap in powershell -EncodedCommand to avoid quoting issues
                  const encoded = Buffer.from(cmd, "utf16le").toString("base64");
                  let result, exitCode;
                  try {
                    const outcome = await new Promise((resolve, reject) => {
                      exec(`powershell -NoProfile -EncodedCommand ${encoded}`, {
                        encoding: "utf8",
                        timeout: 60000,
                        cwd,
                        maxBuffer: 1024 * 1024,
                        windowsHide: true,
                      }, (error, stdout, stderr) => {
                        if (error) {
                          resolve({ text: ((stdout || "") + (stderr || "")).trim(), code: error.code || 1 });
                        } else {
                          resolve({ text: (stdout || "").trim(), code: 0 });
                        }
                      });
                    });
                    result = outcome.text;
                    exitCode = outcome.code;
                  } catch (execErr) {
                    result = execErr.message;
                    exitCode = 1;
                  }
                  // Truncate huge outputs so the AI can still parse the result
                  const maxLen = 6000;
                  if (result.length > maxLen) {
                    result = result.slice(0, maxLen) + `\n\n[truncated ${result.length - maxLen} chars]`;
                  }
                  tc = `Command output (exit ${exitCode}):\n${result}`;
                }
              } catch (execErr) {
                log(`[term] proxy-exec fail: ${execErr.message}`);
              }
            }
          }
        }
        if (toolLoopBroken) continue;
        if (/error|fail|invalid|timeout/i.test(tc)) {
          toolFailStreak++;
          if (toolFailStreak > 3) { toolLoopBroken = true; log("  breaking tool retry loop (>3 consecutive errors)"); continue; }
        } else {
          toolFailStreak = 0;
        }
        userMsgs.push({
          role: "tool",
          tool_call_id: m.tool_call_id || "unknown",
          content: tc,
        });
      }
    }

    // Identity override — MUST be first system instruction to override VS built-in
    systemMsg = compactIdentity(goModel, thinkingTag) + (systemMsg ? "\n\n" : "") + systemMsg;

    // Inject tool instructions into system prompt for agent mode (token-optimized)
    if (vsTools?.length) {
      systemMsg += (systemMsg ? "\n\n" : "") + compactToolInstructions();
      // Terminal guidance: tell AI how to handle VS terminal unavailability
      if (config.terminalFallback !== false && vsTools.some(t => t.function?.name === "run_command_in_terminal" || t.function?.name === "execute_command")) {
        systemMsg += "\n\nVS TERMINAL: The Visual Studio terminal may not be available. If run_command_in_terminal fails with 'Failed to find a valid Visual Studio terminal', output the command in a ```powershell code block for the user to paste into Developer PowerShell (View > Terminal in VS).";
      }
    }

    // VS: prepend project file update instruction at TOP for maximum attention
    if (vs2026 || vsInsiders || (clientTag && clientTag !== "vscode" && /^vs/.test(clientTag))) {
      systemMsg = "CRITICAL WORKFLOW for file creation:\n1. Output the new file as: ## `filename`\n```lang\ncode\n```\n2. Output a code block to ADD the new file to the project: ## `project.ext`\n```xml\n<ItemGroup>\n  <Content Include=\"filename\" />\n</ItemGroup>\n```\n\n" + systemMsg;
    }

    // Forward to Go API with native tool support
    const apiMessages = [];
    if (systemMsg) apiMessages.push({ role: "system", content: systemMsg });
    apiMessages.push(...userMsgs);

    // Apply prompt compression — auto-select best level per model tier
    let compLevel = config.compressionLevel;
    if (compLevel === "auto") {
      const msgCount = userMsgs.length;
      if (msgCount <= 3) compLevel = "off";                        // tiny convo — not worth compressing
      else if (isPollModel(goModel)) compLevel = "stacked";        // free poll — max savings
      else if (isFreeTierModel(goModel)) compLevel = "stacked";    // free tier — max savings
      else compLevel = "caveman";                                   // paid — preserve quality
    }
    const compressedMessages = compressMessages(apiMessages, compLevel, true);

    const ollamaReq = { model: goModel, messages: compressedMessages, stream: streamMode, tools: vsTools || undefined, clientTag };
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
        let allToolCalls = [...tcBuilders.values()].map(normalizeToolCall);
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
      allToolCalls = nativeCalls.map(normalizeToolCall);
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
  const isPoll = isPollModel(goId);
  const prefix = isPoll ? "[FREE_P] " : (isFree ? "[FREE] " : "[GO] ");
  const displayName = vsc ? prefix + info.name : info.name;
  return c.json({
    license: "See OpenAI license terms for this model.",
    modelfile: `# ${info.name} (via OpenCode Go)\nFROM ${goId}`,
    parameters: `num_ctx ${ctxLen}\nnum_predict 4096`,
    template: '{{ if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}{{ range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n',
    version: "1.0.0",
    billing: { multiplier: 1 },
    pricing: isPoll ? "free_poll" : (isFree ? "free" : "premium"),
    context_length: ctxLen,
    max_output_tokens: 4096,
    capabilities: caps,
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
      "opencode.capabilities": caps.join(", "),
    },
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
  const messages = body.messages || [];

  // ── Client detection for /api/chat ──
  let clientTag = "";
  for (const m of messages) {
    let raw = typeof m.content === "string" ? m.content.trim() : "";
    if (Array.isArray(m.content)) raw = m.content.map(p => (p?.text || p?.content || "").trim()).join("\n");
    const c = raw.toLowerCase();
    if (c.startsWith("## [lp]") || c.startsWith("## [pilot]") || c.startsWith("## task") || c.includes("[lp]") || c.includes("</task_type>") || c.includes("</instruction>")) { clientTag = "lp"; break; }
  }
  if (!clientTag) {
    const mea = isSqlStudio(c);
    const vsInsiders = isVSInsiders(c);
    if (mea) clientTag = "sql";
    else if (vsInsiders) clientTag = "vsi";
    else if (isVS2026(c)) clientTag = "vs";
    else if (isVSCode(c)) clientTag = "vscode";
  }

  return stream(c, async s => {
    try {
      const cm = ModelConcurrencyManager.getInstance();
      const model = mapModel(body.model);
      const apiThinking = parseThinkingMode(body.model).thinking;
  const vsTools = body.tools;
  _dumpToolSchemas(vsTools);

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
        else if (role === "tool") {
          if (clientTag === "lp") {
            const hasPrev = userMsgs.length > 0 && userMsgs[userMsgs.length - 1].role === "assistant" && userMsgs[userMsgs.length - 1].tool_calls?.length;
            if (!hasPrev) { log("  [lp] dropping orphan tool message (/api/chat)"); continue; }
          }
          userMsgs.push({ role: "tool", tool_call_id: m.tool_call_id || "unknown", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || "") });
        }
        else if (role === "user") userMsgs.push(m);
        // unknown roles are silently dropped
      }

      // Identity override — MUST be first system instruction
      systemMsg = compactIdentity(model, apiThinking) + (systemMsg ? "\n\n" : "") + systemMsg;

      if (vsTools?.length) {
        systemMsg += (systemMsg ? "\n\n" : "") + compactOllamaToolInstructions(vsTools);
      }

      const apiMessages = systemMsg ? [{ role: "system", content: systemMsg }, ...userMsgs] : userMsgs;
      let compLevel = config.compressionLevel;
      if (compLevel === "auto") {
        const msgCount = userMsgs.length;
        if (msgCount <= 3) compLevel = "off";
        else if (isPollModel(model)) compLevel = "stacked";
        else if (isFreeTierModel(model)) compLevel = "stacked";
        else compLevel = "caveman";
      }
      const compressedMessages = compressMessages(apiMessages, compLevel, true);
      const reqBody = { model, messages: compressedMessages, stream: false, options: body.options, format: body.format, clientTag };
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
    const upstream = await fetchWithAgent(`${config.passthroughBaseUrl}${url.pathname}${url.search}`, {
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

// ── Catch-all for unknown routes — log to discover unmapped Copilot endpoints ──

app.all("*", c => {
  const url = new URL(c.req.url);
  if (isPassthroughPath(url.pathname)) {
    return handlePassthrough(c);
  }
  if (url.pathname === "/api/generate") return c.json({ error: `Not found: ${c.req.method} ${c.req.url}` }, 404);
  const ua = c.req.header("User-Agent") || "";
  const bag = c.req.header("baggage") || "";
  log(`\x1b[33m[404]\x1b[0m ${c.req.method} ${c.req.path}  UA=${ua.slice(0, 50)}  bag=${bag.slice(0, 50)}`);
  return c.json({ error: `Not found: ${c.req.method} ${c.req.url}` }, 404);
});

// ── Start ──

let serverRef = null;

// Port check: if taken (e.g. Ollama), try next
let port = config.port;
const host = config.host;

// IIFE wrapper — Node.js 26.1.0 doesn't support top-level await in bare blocks
(async () => {
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

  if (_isServiceMode) {
    try { process.stderr.write("[gc2oc] entering service mode\r\n"); } catch {}
    try {
      await runAsService({
        onStart: _runServer,
        onStop: () => {
          log("Service stopping...");
          if (serverRef?.stop) serverRef.stop(true);
          else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(); }
        }
      });
    } catch (e) {
      try { process.stderr.write(`[gc2oc] runAsService error: ${e?.message || e}\r\n`); } catch {}
      process.exit(1);
    }
  } else {
    await _runServer();
  }
})().catch(e => { process.stderr.write(`[gc2oc] fatal: ${e?.message || e}\r\n`); process.exit(1); });

// ── Server lifecycle ──
async function _runServer() {
  // Start HTTP server
  if (typeof Bun !== 'undefined' && typeof Bun.serve === 'function') {
  serverRef = Bun.serve({ port, hostname: host, fetch: app.fetch, idleTimeout: 120, reusePort: true, backlog: 1024, maxRequestBodySize: Math.max(262144, parseInt(Bun.env.MAX_REQUEST_BODY_BYTES || "10485760", 10)) });
  log(`Listening on http://${host}:${serverRef.port}`);
} else if (typeof process !== 'undefined' && process.versions?.node) {
  const http = await import("http");
  serverRef = http.createServer({ noDelay: true, maxHeaderSize: 65536 }, (req, res) => {
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
  serverRef.timeout = 120000;
  serverRef.headersTimeout = 65000;
  serverRef.requestTimeout = 120000;
  serverRef.keepAliveTimeout = 65000;
  serverRef.maxHeadersCount = 200;
  await new Promise((resolve) => {
    serverRef.listen(port, host, 1024, () => {
      log(`Listening on http://${host}:${port}`);
      resolve();
    });
  });
}

// Load models & show banner in background
let models = await initModels();

process.stdout.write("\x1b]2;gc2oc\x07");

await checkVersion();

// Wait for background paid-model fetch to complete, then refresh model list
await bgFetchDone();
models = await getModels();

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
const hasPoll = models.some(m => m.model === `${SEP_FREE_P}:latest`);
const hasM365 = models.some(m => m.model === `${SEP_M365}:latest`);
const modeLabel = (hasPaid
  ? (config.hideFree ? " \x1b[32m(premium mode)\x1b[90m" : " \x1b[32m(premium+free mode)\x1b[90m")
  : (hasPoll ? " \x1b[33m(free+poll mode)\x1b[90m" : " \x1b[33m(free mode)\x1b[90m"))
  + (hasM365 ? " \x1b[36m+ M365\x1b[90m" : "");
if (hasPaid) { const ks = getKeyStatus(); const firstKey = ks[0]?.keyPrefix || "?"; log(`\x1b[32m[status] Authenticated — Premium+Free (${firstKey})\x1b[0m`); }
else if (hasPoll) log("\x1b[33m[status] Free mode — OpenCode free + Pollinations\x1b[0m");
else log("\x1b[33m[status] Free mode — no API key\x1b[0m");
if (hasM365) log("\x1b[36m[status] M365 Copilot connected\x1b[0m");

P("");
P(W + "\u256d" + hr + W + "\u256e" + R);
P(line(S + B + "\u250f\u2513\u2513\u250f\u250f\u2513\u250f\u2513\u250f\u2513\u250f\u2513\u250f\u2513" + R));
P(line(S + B + "\u2503\u2513\u2523\u252b\u2503 \u2503\u2503\u250f\u251b\u2503\u2503\u2503 " + R + " " + S + "github copilot proxy" + modeLabel + R));
P(line(S + B + "\u2517\u251b\u251b\u2517\u2517\u251b\u2523\u251b\u2517\u2501\u2517\u251b\u2517\u251b" + R));
P(W + "\u251c" + hr + W + "\u2524" + R);
const portLabel = port === 11434 ? `port: ${port} (default)` : `port: ${port}`;
P(line(S + portLabel + "  │  vs2026  │  models.dev" + R));
P(W + "\u251c" + hr + W + "\u2524" + R);

// Split models into sections by separator order (M365 → Free → Poll → Premium)
const m365Start = models.findIndex(m => m.model === `${SEP_M365}:latest`);
const freeStart = models.findIndex(m => m.model === `${SEP_FREE}:latest`);
const pollStart = models.findIndex(m => m.model === `${SEP_FREE_P}:latest`);
const paidStart = models.findIndex(m => m.model === `${SEP_PAID}:latest`);

// Each section: from its separator+1 to the next separator (or end)
const m365End = [freeStart, pollStart, paidStart, models.length].find(i => i >= 0);
const freeEnd = [pollStart, paidStart, models.length].find(i => i >= 0);
const pollEnd = [paidStart, models.length].find(i => i >= 0);

const m365Models = m365Start >= 0 ? models.slice(m365Start + 1, m365End) : [];
const freeModels = freeStart >= 0 ? models.slice(freeStart + 1, freeEnd) : [];
const pollModels = pollStart >= 0 ? models.slice(pollStart + 1, pollEnd) : [];
const paidModels = paidStart >= 0 ? models.slice(paidStart + 1) : [];

function printTable(list) {
  for (const m of list) {
    const name = m.name.length > 20 ? m.name.slice(0, 19) + "\u2026" : m.name.padEnd(20);
    const id = (m.model.replace(":latest", "")).length > 24
      ? (m.model.replace(":latest", "")).slice(0, 23) + "\u2026"
      : (m.model.replace(":latest", "")).padEnd(24);
    const params = m.maxParams ? m.maxParams.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".").padEnd(9) : "-".padEnd(9);
    P(line(name + S + " \u2502 " + R + id + S + " \u2502 " + R + params + R));
  }
}

if (hasM365) {
  P(line(S + "M365 Copilot: " + S + `(${m365Models.length})` + R));
  P(line(S + "Name".padEnd(20) + " \u2502 " + "ID".padEnd(24) + " \u2502 " + "Context" + R));
  printTable(m365Models);
}

if (!config.hideFree && freeModels.length) {
  if (hasM365) P(line(""));
  P(line(S + "Free: " + S + `(${freeModels.length})` + R));
  P(line(S + "Name".padEnd(20) + " \u2502 " + "ID".padEnd(24) + " \u2502 " + "Context" + R));
  printTable(freeModels);
}

if (config.showPollModels && pollModels.length) {
  if (!config.hideFree && freeModels.length) P(line(""));
  P(line(S + "Pollinations: " + S + `(${pollModels.length})` + R));
  P(line(S + "Name".padEnd(20) + " \u2502 " + "ID".padEnd(24) + " \u2502 " + "Context" + R));
  printTable(pollModels);
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
(async () => {
  let canUpdate = false;
  try {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    canUpdate = existsSync(join(process.cwd(), "update.cmd"));
  } catch {}
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
        if (serverRef?.stop) { serverRef.stop(true); restartSelf(); }
        else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf()); }
        else { restartSelf(); }
        setTimeout(() => process.exit(42), 5000);
      } else if (canUpdate && (cmd === "update" || cmd === "u")) {
        log("Updating and restarting...");
        if (serverRef?.stop) { serverRef.stop(true); restartSelf(43); }
        else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf(43)); }
        else { restartSelf(43); }
        setTimeout(() => process.exit(43), 5000);
      } else if (cmd) {
        err(`Unknown command: ${cmd}`);
      }
    });
    process.stdin.resume();
    if (canUpdate) {
      log("\x1b[96mr\x1b[37m/\x1b[96mrestart\x1b[90m | \x1b[96ms\x1b[37m/\x1b[96mstop\x1b[90m | \x1b[96me\x1b[37m/\x1b[96mexit\x1b[90m | \x1b[96mu\x1b[37m/\x1b[96mupdate\x1b[0m");
    } else {
      log("\x1b[96mr\x1b[37m/\x1b[96mrestart\x1b[90m | \x1b[96ms\x1b[37m/\x1b[96mstop\x1b[90m | \x1b[96me\x1b[37m/\x1b[96mexit\x1b[0m");
    }
  }
})();
}

// ── Self-restart helper for standalone (.exe) runs ──
// Restart helper. When wrapped (GC2OC_WRAPPED=1), exit and let the wrapper loop restart.
// Standalone: spawn cmd /c start /D wd cmd /c exe — opens a new independent console.
// NOTE: paths passed without quotes because Bun wraps the entire cmd arg in quotes,
// and nested quotes would break CMD parsing.
async function restartSelf(exitCode = 42) {
  if (process.env.GC2OC_WRAPPED) {
    process.exit(exitCode);
    return;
  }
  try {
    const pathMod = await import("node:path");
    const exe = process.execPath;
    const wd = pathMod.dirname(exe);
    const args = process.argv.slice(1).join(" ");
    const cmd = `start /D ${wd} cmd /c ${exe} ${args}`.trim();

    if (typeof Bun !== 'undefined') {
      Bun.spawn(["cmd", "/c", cmd], {
        stdout: "ignore", stderr: "ignore", stdin: "ignore",
      }).unref();
    } else {
      const { spawn } = await import("node:child_process");
      spawn("cmd", ["/c", cmd], {
        detached: true, stdio: "ignore", windowsHide: true,
      }).unref();
    }
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    err("Self-restart spawn failed: " + e.message);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.exit(exitCode);
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

