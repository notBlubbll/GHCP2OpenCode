const config = {
  apiKey: Bun.env.OPENCODE_API_KEY ?? "",
  baseUrl: Bun.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  host: Bun.env.SERVER_HOST ?? "127.0.0.1",
  port: parseInt(Bun.env.SERVER_PORT ?? "3000", 10),
  defaultModel: Bun.env.DEFAULT_MODEL ?? "deepseek-v4-flash",
};

// ── Dynamic model list from models.dev API ──

let _models = null;
let _modelMap = {};

const MODEL_ALIASES = {};

const MODEL_META = {
  "deepseek-v4-flash": { name: "DeepSeek V4 Flash", tools: true, vision: false },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", tools: true, vision: false },
  "qwen3.5-plus": { name: "Qwen3.5 Plus", tools: true, vision: true },
  "qwen3.6-plus": { name: "Qwen3.6 Plus", tools: true, vision: true },
  "minimax-m2.5": { name: "MiniMax M2.5", tools: true, vision: false },
  "minimax-m2.7": { name: "MiniMax M2.7", tools: true, vision: false },
  "kimi-k2.5": { name: "Kimi K2.5", tools: true, vision: true },
  "kimi-k2.6": { name: "Kimi K2.6", tools: true, vision: true },
  "glm-5": { name: "GLM-5", tools: true, vision: false },
  "glm-5.1": { name: "GLM-5.1", tools: true, vision: false },
  "mimo-v2-omni": { name: "MiMo V2 Omni", tools: true, vision: true },
  "mimo-v2.5": { name: "MiMo V2.5", tools: true, vision: true },
  "mimo-v2-pro": { name: "MiMo V2 Pro", tools: true, vision: true },
  "mimo-v2.5-pro": { name: "MiMo V2.5 Pro", tools: true, vision: true },
};

async function fetchModels() {
  const resp = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const models = [];

  for (const m of (data.data ?? [])) {
    const meta = MODEL_META[m.id] || { name: m.id, tools: true, vision: false };

    models.push({
      name: `${m.id}:latest`,
      model: `${m.id}:latest`,
      modified_at: now,
      size: 0,
      digest: "",
      details: {
        parent_model: "",
        format: "gguf",
        family: meta.name,
        families: [meta.name],
        parameter_size: "",
        quantization_level: "F16",
        tools: meta.tools,
        vision: meta.vision,
        supports_tools: meta.tools,
        supports_function_calling: meta.tools,
        supports_vision: meta.vision,
      },
      capabilities: { tools: meta.tools, vision: meta.vision, function_calling: meta.tools, tool_calling: meta.tools },
      supports_tools: meta.tools,
      supports_function_calling: meta.tools,
    });

    _modelMap[m.id.toLowerCase()] = { id: m.id, name: meta.name, tools: meta.tools, vision: meta.vision };
  }

  _models = models;
  console.log(`[models] Fetched ${models.length} Go models`);
  return _models;
}

export function getModels() {
  if (_models) return _models;
  return fetchModels();
}

export function resolveModel(name) {
  const clean = name.split(":")[0].trim().toLowerCase();
  if (_modelMap[clean]) return _modelMap[clean];
  return { id: clean, name: clean, tools: true, vision: false };
}

function isoNow() { return new Date().toISOString(); }

// ── Direct OpenCode Go API calls ──

async function zenRequest(endpoint, body) {
  const url = `${config.baseUrl}${endpoint}`;
  console.log(`[zen] POST ${url} model=${body.model}`);
  
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.log(`[zen] <- ${resp.status}: ${txt.slice(0, 300)}`);
    throw new Error(`OpenCode API ${resp.status}: ${txt}`);
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
    console.error(`[chat] ${e.message}`);
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
