// Cross-runtime compatibility polyfill
if (typeof Bun === 'undefined') {
  globalThis.Bun = {
    env: process.env,
    // Add other Bun-specific globals if needed
  };
}

const FREE_TIER_MODELS = [
  { id: "big-pickle", name: "Big Pickle", family: "big-pickle", tools: true, vision: true },
  { id: "hy3-preview-free", name: "Hy3 Preview Free", family: "hy3-free", tools: true, vision: true },
  { id: "ling-2.6-flash-free", name: "Ling 2.6 Flash Free", family: "ling-flash-free", tools: true, vision: false },
  { id: "minimax-m2.5-free", name: "MiniMax M2.5 Free", family: "minimax-free", tools: true, vision: true },
  { id: "nemotron-3-super-free", name: "Nemotron 3 Super Free", family: "nemotron-free", tools: true, vision: true },
  { id: "trinity-large-preview-free", name: "Trinity Large Preview", family: "trinity", tools: true, vision: true },
];

function buildFreeTierModels() {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const allModels = { ...((_mdCache && _mdCache["opencode-go"]?.models) || {}), ...((_mdCache && _mdCache["opencode"]?.models) || {}) };
  const active = FREE_TIER_MODELS.filter(m => {
    if (m._active === false) return false;
    if (allModels[m.id]?.status === "deprecated") return false;
    return true;
  });
  return active
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(m => {
      const mdModel = allModels[m.id];
      return {
      name: m.name,
      model: `${m.id}:latest`,
      modified_at: now,
      size: 0,
      digest: m.id,
      maxParams: mdModel?.limit?.context || "",
      details: {
        parent_model: "",
        format: "gguf",
        family: m.family,
        families: [m.family],
        parameter_size: "",
        quantization_level: "F16",
        tools: m.tools,
        vision: m.vision,
        supports_tools: m.tools,
        supports_function_calling: m.tools,
        supports_vision: m.vision,
      },
      capabilities: { tools: m.tools, vision: m.vision, function_calling: m.tools, tool_calling: m.tools },
      supports_tools: m.tools,
      supports_function_calling: m.tools,
    }});
}

async function pingFreeModel(m) {
  const start = Date.now();
  try {
    const resp = await fetch(`${config.baseUrlFree}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: m.id,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    return { ok: resp.ok, ms: Date.now() - start };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}

export async function validateFreeModels() {
  console.log("[models] pinging free models...");
  const results = await Promise.all(FREE_TIER_MODELS.map(async (m) => {
    const { ok, ms } = await pingFreeModel(m);
    m._active = ok;
    console.log(`[models]   ${m.id} - ${ok ? "OK" : "OFFLINE"} (${ms}ms)`);
    return ok;
  }));
  return results.filter(Boolean).length;
}

function sepModel(id, label) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return {
    name: label,
    model: `${id}:latest`,
    modified_at: now,
    size: 0,
    digest: id,
    details: { parent_model: "", format: "", family: "", families: null, parameter_size: "", quantization_level: "" },
    capabilities: {},
    supports_tools: false,
    supports_function_calling: false,
  };
}

export function isFreeTierModel(id) {
  const clean = (id || "").split(":")[0].trim().toLowerCase();
  return FREE_TIER_MODELS.some(m => m.id === clean);
}

export function isSeparator(id) {
  const clean = (id || "").split(":")[0].trim().toLowerCase();
  return clean === SEP_FREE || clean === SEP_PAID;
}

const SEP_FREE = "(free)";
const SEP_PAID = "(go)";

const config = {
  get apiKey() { return Bun.env.OPENCODE_API_KEY ?? ""; },
  get hasKey() {
    if (Bun.env.OPENCODE_API_KEY) return true;
    if (Bun.env.OPENCODE_API_KEYS) {
      try { return JSON.parse(Bun.env.OPENCODE_API_KEYS).length > 0; } catch {}
    }
    return false;
  },
  baseUrl: Bun.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  baseUrlFree: Bun.env.OPENCODE_BASE_FREE_URL ?? "https://opencode.ai/zen/v1",
  host: Bun.env.SERVER_HOST ?? "127.0.0.1",
  port: parseInt(Bun.env.SERVER_PORT ?? "11434", 10),
  defaultModel: Bun.env.DEFAULT_MODEL ?? "big-pickle",
  get defaultTemperature() {
    const t = parseFloat(Bun.env.DEFAULT_TEMPERATURE);
    return isNaN(t) ? null : t;
  },
};

export function setApiKey(key) { Bun.env.OPENCODE_API_KEY = key; }

// ── Key rotation ──

let _keys = [];
let _keyIdx = 0;
const _keyCooldown = new Map(); // key -> cooldownUntil timestamp

function loadKeys() {
  if (Bun.env.OPENCODE_API_KEYS) {
    try { _keys = JSON.parse(Bun.env.OPENCODE_API_KEYS); } catch { _keys = []; }
  }
  if (_keys.length === 0 && Bun.env.OPENCODE_API_KEY) {
    _keys = [Bun.env.OPENCODE_API_KEY];
  }
}

function withKey() {
  loadKeys();
  const now = Date.now();
  for (let i = 0; i < _keys.length; i++) {
    const idx = (_keyIdx + i) % _keys.length;
    const key = _keys[idx];
    if (!_keyCooldown.has(key) || _keyCooldown.get(key) < now) {
      _keyIdx = (idx + 1) % _keys.length;
      return key;
    }
  }
  // All keys on cooldown — try first anyway
  return _keys[0] || "";
}

function cooldownKey(key, ms = 30000) {
  _keyCooldown.set(key, Date.now() + ms);
}

export function rotateKey() {
  const bad = _keys[_keyIdx % _keys.length];
  if (bad) cooldownKey(bad);
}

// ── Dynamic model list ──

let _models = null;
let _modelMap = {};
let _nameToId = {}; // display name -> id for reverse lookup
let _mdCache = null; // models.dev cache
let _diskCachePath = null;
let _fs = null; // lazy-loaded fs module

async function _loadFs() {
  if (!_fs) _fs = await import("node:fs");
  return _fs;
}

function getDiskPath() {
  if (_diskCachePath) return _diskCachePath;
  const dir = Bun.env.OPENCODE_CACHE_DIR || (typeof process !== 'undefined' ? process.cwd() : ".");
  _diskCachePath = `${dir}/.ghcp2oc_models.json`;
  return _diskCachePath;
}

function keyHash() {
  const keys = [];
  // Read from process env
  if (Bun.env.OPENCODE_API_KEY) keys.push(Bun.env.OPENCODE_API_KEY);
  if (Bun.env.OPENCODE_API_KEYS) {
    try { keys.push(...JSON.parse(Bun.env.OPENCODE_API_KEYS)); } catch {}
  }
  // Also read .env file directly (catches mid-run changes before restart)
  try {
    if (_fs) {
      const envRaw = _fs.readFileSync(".env", "utf8");
      for (const line of envRaw.split("\n")) {
        const m = line.match(/^\s*OPENCODE_API_KEYS?\s*=\s*(.+)/);
        if (m) {
          const val = m[1].replace(/^["']|["']$/g, "").trim();
          if (val.startsWith("[")) {
            try { keys.push(...JSON.parse(val)); } catch { keys.push(val); }
          } else if (val.length > 5) {
            keys.push(val);
          }
        }
      }
    }
  } catch {}
  const deduped = [...new Set(keys)].sort();
  if (!deduped.length) return "no-key";
  const combined = deduped.join("");
  let h = 0;
  for (let i = 0; i < combined.length; i++) {
    h = ((h << 5) - h + combined.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function getKeyHashPath() {
  const dir = Bun.env.OPENCODE_CACHE_DIR || (typeof process !== 'undefined' ? process.cwd() : ".");
  return `${dir}/.ghcp2oc_keyhash.json`;
}

function loadKeyHashFromDisk() {
  try {
    if (!_fs) { console.log("[keys] no fs module loaded"); return null; }
    const path = getKeyHashPath();
    const data = JSON.parse(_fs.readFileSync(path, "utf8"));
    console.log(`[keys] loaded hash from ${path}: ${data.h}`);
    return data.h || null;
  } catch (e) {
    console.log(`[keys] no hash file yet (${e.message})`);
    return null;
  }
}

function saveKeyHashToDisk(h) {
  if (!_fs) { console.log("[keys] no fs module loaded"); return; }
  try {
    const path = getKeyHashPath();
    _fs.writeFileSync(path, JSON.stringify({ h }));
    console.log(`[keys] saved hash ${h} to ${path}`);
  } catch (e) {
    console.log(`[keys] save failed: ${e.message}`);
  }
}

let _lastKeyHash = null;
async function checkKeyChanged() {
  const h = keyHash();
  if (!_lastKeyHash) {
    _lastKeyHash = loadKeyHashFromDisk();
  }
  if (_lastKeyHash !== null && _lastKeyHash !== h) {
    console.log(`[keys] changed: ${_lastKeyHash} → ${h}`);
    _lastKeyHash = h;
    saveKeyHashToDisk(h);
    return true;
  }
  _lastKeyHash = h;
  return false;
}

function loadModelsFromDisk() {
  try {
    if (!_fs) return false;
    // Require key hash file to exist — if missing, force refresh
    if (!_fs.existsSync(getKeyHashPath())) {
      console.log("[models] key hash file missing — forcing refresh");
      return false;
    }
    const data = JSON.parse(_fs.readFileSync(getDiskPath(), "utf8"));
    if (data._models?.length) {
      if (data._keyHash !== undefined && data._keyHash !== keyHash()) {
        console.log("[models] API key changed, ignoring disk cache");
        return false;
      }
      _models = data._models;
      _modelMap = data._modelMap || {};
      _nameToId = data._nameToId || {};
      console.log(`[models] loaded ${_models.length} from disk cache`);
      return true;
    }
  } catch {}
  return false;
}

async function saveModelsToDisk() {
  try {
    await _loadFs();
    const path = getDiskPath();
    _fs.writeFileSync(path, JSON.stringify({ _models, _modelMap, _nameToId, _keyHash: keyHash() }));
    console.log(`[cache] saved to ${path}`);
  } catch (e) {
    console.error(`[cache] save failed: ${e.message}`);
  }
}

async function fetchModelsDev() {
  if (_mdCache) return _mdCache;
  const resp = await fetch("https://models.dev/api.json");
  if (!resp.ok) return {};
  const data = await resp.json();
  _mdCache = data;
  return data;
}

async function fetchModels() {
  const start = Date.now();
  const md = await fetchModelsDev();
  const allModels = { ...(md["opencode-go"]?.models || {}), ...(md["opencode"]?.models || {}) };
  const goModels = md["opencode-go"]?.models || {};
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  // Always start with free tier models (alphabetical)
  const models = [];
  models.push(sepModel(SEP_FREE, "\u2550\u2550 FREE: \u2550\u2550"));
  models.push(...buildFreeTierModels());
  const freeSet = new Set(FREE_TIER_MODELS.map(m => m.id));
  let paidFrom = "";
  let paidCount = 0;

  // If API key is set, also fetch paid models
  if (_paidGoData?.data?.length) {
    try {
      const goData = _paidGoData;
      _paidGoData = null;

      const paidModels = [];

      for (const m of goData.data ?? []) {
          if (freeSet.has(m.id)) continue;
          const mdModel = goModels[m.id];
          const displayName = mdModel?.name || m.id;
          const tools = mdModel?.tool_call ?? true;
          const vision = (mdModel?.modalities?.input || []).some(v => v === "image" || v === "video");

          paidModels.push({
            name: displayName,
            model: `${m.id}:latest`,
            modified_at: now,
            size: 0,
            digest: m.id,
            maxParams: allModels[m.id]?.limit?.context || "",
            details: {
              parent_model: "",
              format: "gguf",
              family: displayName,
              families: [displayName],
              parameter_size: mdModel?.parameter_size || mdModel?.parameter_count || "",
              quantization_level: "F16",
              tools,
              vision,
              supports_tools: tools,
              supports_function_calling: tools,
              supports_vision: vision,
            },
            capabilities: { tools, vision, function_calling: tools, tool_calling: tools },
            supports_tools: tools,
            supports_function_calling: tools,
          });

          _modelMap[m.id.toLowerCase()] = { id: m.id, name: displayName, tools, vision };
          _nameToId[displayName.toLowerCase()] = m.id;
        }

        paidModels.sort((a, b) => a.name.localeCompare(b.name));
        paidCount = paidModels.length;
        paidFrom = "OpenCode API";

        models.push(sepModel(SEP_PAID, "\u2550\u2550 PREMIUM: \u2550\u2550"));
        models.push(...paidModels);
      } catch (e) {
        console.error(`[models] Failed to build paid models: ${e.message}`);
    }
  }

  // Always register free models in the maps
  for (const m of FREE_TIER_MODELS) {
    _modelMap[m.id.toLowerCase()] = { id: m.id, name: m.name, tools: m.tools, vision: m.vision };
    _nameToId[m.name.toLowerCase()] = m.id;
  }

  _models = models;
  const elapsed = Date.now() - start;
  const freeCount = FREE_TIER_MODELS.length;
  const totalReal = models.filter(m => !isSeparator(m.model)).length;
  const paidLabel = paidCount > 0 ? ` (${freeCount} free + ${paidCount} paid)` : "";
  const sourceLabel = paidFrom ? ` from ${paidFrom}` : "";
  console.log(`[models] ${totalReal} total${paidLabel}${sourceLabel} (${elapsed}ms)`);
  return _models;
}

export async function initModels() {
  await _loadFs();
  const changed = await checkKeyChanged();
  if (!changed && loadModelsFromDisk()) {
    console.log("[models] keys unchanged, using disk cache");
    return _models;
  }
  // No valid cache, or key changed — fresh fetch
  if (!changed) console.log("[models] no cache or key hash missing — fresh fetch");
  await Promise.all([
    validateFreeModels(),
    fetchGoModelsRaw(),
  ]);
  await fetchModels();
  await saveModelsToDisk();
  saveKeyHashToDisk(keyHash());
  return _models;
}

export function getModels() {
  if (_models) return _models;
  return fetchModels();
}

let _paidGoData = null;

async function fetchGoModelsRaw() {
  const keys = [];
  if (Bun.env.OPENCODE_API_KEY) keys.push(Bun.env.OPENCODE_API_KEY);
  if (Bun.env.OPENCODE_API_KEYS) {
    try { keys.push(...JSON.parse(Bun.env.OPENCODE_API_KEYS)); } catch {}
  }
  console.log(`[keys] found ${keys.length} key(s) in env`);

  for (const k of keys) {
    try {
      // Validate key with a real chat request (models endpoint is public)
      const ping = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k}` },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
      });
      if (ping.status === 401) {
        console.error(`[models] Go key invalid (${k.slice(0, 8)}...)`);
        continue;
      }

      const goResp = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${k}` },
      });
      if (goResp.ok) {
        _paidGoData = await goResp.json();
        console.log(`[models] Go key valid (${k.slice(0, 8)}...) — ${_paidGoData?.data?.length || 0} paid models`);
        return _paidGoData;
      }
    } catch (e) {
      console.error(`[models] Go API error for key ${k.slice(0, 8)}...: ${e.message}`);
    }
  }

  if (keys.length) console.error("[models] No valid Go API key — free tier only");
  _paidGoData = null;
  return null;
}

export async function refreshModels() {
  console.log("[models] refreshing from API...");
  const start = Date.now();
  await checkKeyChanged();
  await Promise.all([
    validateFreeModels(),
    fetchGoModelsRaw(),
  ]);
  await fetchModels();
  await saveModelsToDisk();
  console.log(`[models] refresh done (${Date.now() - start}ms)`);
}

export function resolveModel(name) {
  let clean = name.split(":")[0].trim().toLowerCase();
  clean = clean.replace(/\s*\(free\)$/i, ""); // strip "(Free)" suffix from tag list
  
  if (isSeparator(clean)) return { id: clean, name: clean, tools: false, vision: false, separator: true };
  
  if (_modelMap[clean]) return _modelMap[clean];
  const nmId = _nameToId[clean];
  if (nmId && _modelMap[nmId]) return _modelMap[nmId];
  
  const freeMatch = FREE_TIER_MODELS.find(m => m.id === clean);
  if (freeMatch) return { id: freeMatch.id, name: freeMatch.name, tools: freeMatch.tools, vision: freeMatch.vision };
  
  return { id: clean, name: clean, tools: true, vision: false };
}

function isoNow() { return new Date().toISOString(); }

// ── Direct OpenCode Go API calls ──

// ── API Error ──

export class APIError extends Error {
  constructor(status, body, message) {
    super(message || `OpenCode API ${status}`);
    this.status = status;
    this.body = body;
    this.name = "APIError";
  }
}

// OpenAI-compatible error codes
const ERROR_CODES = {
  400: "invalid_request",
  401: "invalid_api_key",
  402: "insufficient_quota",
  403: "permission_denied",
  404: "not_found",
  429: "rate_limit_exceeded",
  500: "server_error",
  503: "server_overloaded",
};

async function zenRequest(endpoint, body, opts = {}) {
  const base = isFreeTierModel(body.model) ? config.baseUrlFree : config.baseUrl;
  const url = `${base}${endpoint}`;
  const key = withKey();
  const isFree = isFreeTierModel(body.model);
  
  if (isSeparator(body.model)) {
    throw new APIError(400, "", "This is a category header, not a model. Please select an actual model from the list.");
  }
  
  const lastMsg = body.messages?.[body.messages.length - 1];
  const prompt = typeof lastMsg?.content === "string" ? lastMsg.content : "";
  const preview = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
  console.log(`[zen] ${body.model || "?"}${isFree ? " (free)" : ""} — "${preview}${prompt.length > 60 ? "\u2026" : ""}"`);

  const headers = {
    "Content-Type": "application/json",
  };
  
  // Free models: never send auth. Paid: require key.
  if (key && !isFree) {
    headers["Authorization"] = `Bearer ${key}`;
  } else if (!isFree) {
    throw new APIError(401, "", "No API key configured. Free tier models can be used without a key.");
  }

  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error(`[zen] ${resp.status}`);

    // Rotate key on auth/rate-limit errors
    const retries = opts.retries || 0;
    if (key && (resp.status === 401 || resp.status === 429) && retries < _keys.length) {
      cooldownKey(key, resp.status === 429 ? 15000 : 60000);
      return zenRequest(endpoint, body, { ...opts, retries: retries + 1 });
    }

    let upstreamMsg = "OpenCode API error";
    let code = ERROR_CODES[resp.status] || "api_error";
    let mappedStatus = resp.status;
    try {
      const parsed = JSON.parse(txt);
      upstreamMsg = parsed.error?.message || parsed.message || upstreamMsg;
      if (parsed.error?.type === "AuthError") { code = "invalid_api_key"; mappedStatus = 401; }
      if (parsed.error?.type === "ModelError") { code = "model_not_found"; mappedStatus = 404; }
    } catch {}

    throw new APIError(mappedStatus, txt, upstreamMsg);
  }

  return resp;
}

// ── Chat completion ──

export async function* chatCompletion(req) {
  const info = resolveModel(req.model);
  const created = isoNow();

  const body = {
    model: info.id,
    messages: req.messages.map(msg => {
      const out = { role: msg.role, content: msg.content };
      if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
      if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
      if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
      if (msg.images?.length) {
        out.content = [
          { type: "text", text: msg.content || "" },
          ...msg.images.map(img => ({ type: "image_url", image_url: { url: `data:image/png;base64,${img}` } })),
        ];
      }
      return out;
    }),
    stream: req.stream !== false,
  };

  if (req.tools?.length) {
    body.tools = req.tools.map(t => ({
      type: "function",
      function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
    }));
  }

  if (req.options?.temperature != null) body.temperature = req.options.temperature;
  else if (config.defaultTemperature != null) body.temperature = config.defaultTemperature;
  if (req.options?.top_p != null) body.top_p = req.options.top_p;
  if (req.options?.seed != null) body.seed = req.options.seed;
  if (req.options?.num_predict != null) body.max_tokens = req.options.num_predict;

  try {
    const resp = await zenRequest("/chat/completions", body);

    if (req.stream === false) {
      const data = await resp.json();
      const choice = data.choices[0];
      yield {
        model: req.model, created_at: created,
        message: {
          role: "assistant",
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
          reasoning_content: choice.message.reasoning_content,
        },
        done: true, done_reason: choice.finish_reason ?? "stop",
      };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") {
          yield { model: req.model, created_at: created, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" };
          return;
        }
        try {
          const data = JSON.parse(dataStr);
          const choice = data.choices[0];
          if (choice?.delta?.content) {
            yield { model: req.model, created_at: created, message: { role: "assistant", content: choice.delta.content }, done: false };
          }
          if (choice?.delta?.tool_calls) {
            yield { model: req.model, created_at: created, message: { role: "assistant", content: "", tool_calls: choice.delta.tool_calls }, done: false };
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e instanceof APIError) throw e; // propagate HTTP errors to server.js
    console.error(`[stream] ${e.message}`);
    yield {
      model: req.model, created_at: created,
      message: { role: "assistant", content: `Error: ${e.message}` },
      done: true, done_reason: "error",
    };
  }
}

// ── Generate completion ──

export async function* generateCompletion(req) {
  const created = isoNow();
  let full = "";
  for await (const c of chatCompletion({
    model: req.model,
    messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt, images: req.images }],
    options: req.options, stream: req.stream, format: req.format,
  })) {
    full += c.message.content;
    if (c.done) {
      yield { model: req.model, created_at: created, response: req.stream === false ? full : "", done: true, context: null, total_duration: 0, load_duration: 0, prompt_eval_count: 0, prompt_eval_duration: 0, eval_count: full.split(/\s+/).length, eval_duration: 0 };
    } else if (req.stream !== false) {
      yield { model: req.model, created_at: created, response: c.message.content, done: false };
    }
  }
}

export { config, SEP_PAID, SEP_FREE };
