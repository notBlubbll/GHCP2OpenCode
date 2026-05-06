const config = {
  get apiKey() { return Bun.env.OPENCODE_API_KEY ?? ""; },
  baseUrl: Bun.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  host: Bun.env.SERVER_HOST ?? "127.0.0.1",
  port: parseInt(Bun.env.SERVER_PORT ?? "11434", 10),
  defaultModel: Bun.env.DEFAULT_MODEL ?? "deepseek-v4-flash",
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

async function fetchModelsDev() {
  if (_mdCache) return _mdCache;
  const resp = await fetch("https://models.dev/api.json");
  if (!resp.ok) return {};
  const data = await resp.json();
  _mdCache = data;
  return data;
}

async function fetchModels() {
  const [goResp, md] = await Promise.all([
    fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } }),
    fetchModelsDev(),
  ]);

  if (!goResp.ok) throw new Error(`HTTP ${goResp.status}`);

  const goData = await goResp.json();
  const goModels = md["opencode-go"]?.models || {};
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const models = [];

  for (const m of (goData.data ?? [])) {
    const mdModel = goModels[m.id];
    const displayName = mdModel?.name || m.id;
    const tools = mdModel?.tool_call ?? true;
    const vision = (mdModel?.modalities?.input || []).some(v => v === "image" || v === "video");

    models.push({
      name: displayName,
      model: `${m.id}:latest`,
      modified_at: now,
      size: 0,
      digest: "",
      details: {
        parent_model: "",
        format: "gguf",
        family: displayName,
        families: [displayName],
        parameter_size: "",
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

  _models = models;
  console.log(`[models] ${models.length} from Go API`);
  return _models;
}

export function getModels() {
  if (_models) return _models;
  return fetchModels();
}

export function resolveModel(name) {
  const clean = name.split(":")[0].trim().toLowerCase();
  if (_modelMap[clean]) return _modelMap[clean];
  const id = _nameToId[clean];
  if (id && _modelMap[id]) return _modelMap[id];
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

async function zenRequest(endpoint, body, retries = 0) {
  const url = `${config.baseUrl}${endpoint}`;
  const key = withKey();
  if (!key) throw new APIError(401, "", "No API key configured");
  console.log(`[zen] ${body.model}`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error(`[zen] ${resp.status}`);

    // Rotate key on auth/rate-limit errors
    if ((resp.status === 401 || resp.status === 429) && retries < _keys.length) {
      cooldownKey(key, resp.status === 429 ? 15000 : 60000);
      return zenRequest(endpoint, body, retries + 1);
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

export { config };
