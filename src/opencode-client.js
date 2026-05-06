const config = {
  apiKey: Bun.env.OPENCODE_API_KEY ?? "",
  baseUrl: Bun.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  host: Bun.env.SERVER_HOST ?? "127.0.0.1",
  port: parseInt(Bun.env.SERVER_PORT ?? "11434", 10),
  defaultModel: Bun.env.DEFAULT_MODEL ?? "deepseek-v4-flash",
};

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
  const id = _nameToId[clean];
  if (id && _modelMap[id]) return _modelMap[id];
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
