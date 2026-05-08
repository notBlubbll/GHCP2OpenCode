import { WebSocket } from "ws";

export class M365CopilotError extends Error {
  constructor(message) {
    super(message);
    this.name = "M365CopilotError";
  }
}

if (typeof Bun === "undefined") {
  globalThis.Bun = { env: process.env };
}

function getRelayUrl() {
  const port = Bun.env.M365CO_PORT || Bun.env.M365C_PORT;
  if (!port) return null;
  return `ws://127.0.0.1:${port}`;
}

const M365_MODEL_QUICK = {
  id: "m365-copilot-quick",
  name: "M365 Copilot Quick",
  family: "m365-copilot",
  relayModel: "gpt-5.5-quick",
  tools: false,
  vision: false,
  _m365: true,
};

const M365_MODEL_THINK = {
  id: "m365-copilot-think",
  name: "M365 Copilot Think",
  family: "m365-copilot",
  relayModel: "gpt-5.5-think-deeper",
  tools: false,
  vision: false,
  _m365: true,
};

const ALL_M365_MODELS = [M365_MODEL_QUICK, M365_MODEL_THINK];

export function getM365RelayModel(modelId) {
  const clean = (modelId || "").split(":")[0].trim().toLowerCase();
  for (const m of ALL_M365_MODELS) {
    if (m.id === clean) return m.relayModel;
  }
  return M365_MODEL_QUICK.relayModel;
}

let _cachedModels = null;
let _available = null;

export async function isM365Available() {
  if (_available !== null) return _available;
  _available = !!getRelayUrl();
  return _available;
}

export async function getM365Models() {
  if (_cachedModels !== null) return _cachedModels;
  const available = await isM365Available();
  if (!available) { _cachedModels = []; return []; }
  _cachedModels = ALL_M365_MODELS;
  return _cachedModels;
}

export function clearM365Cache() {
  _cachedModels = null;
  _available = null;
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => p?.text || p?.content || "").join("");
  return "";
}

function buildMessagesPayload(messages) {
  const systemParts = [];
  const nonSystem = [];

  for (const m of messages) {
    const role = (m.role || "").toLowerCase();
    const content = extractContent(m.content);
    if (role === "system") {
      if (content) systemParts.push(content);
    } else {
      nonSystem.push({ role, content });
    }
  }

  const payload = { messages: nonSystem };
  if (systemParts.length) payload.system = systemParts.join("\n");
  return payload;
}

function buildM365ChatText(payload) {
  const contextLines = [];

  if (payload.system) {
    contextLines.push("System instructions:\n" + payload.system);
  }

  const msgs = payload.messages || [];
  const priorMsgs = msgs.slice(0, -1);
  const lastMsg = msgs[msgs.length - 1];

  if (priorMsgs.length) {
    contextLines.push("Prior conversation transcript:\n" +
      priorMsgs.map(m => m.role.charAt(0).toUpperCase() + m.role.slice(1) + ": " + m.content).join("\n"));
  }

  const context = contextLines.join("\n\n");
  const prompt = lastMsg ? lastMsg.content : "";

  if (!context) return prompt;
  return context + "\n\n---\n\n" + prompt;
}

function connectRelay(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = getRelayUrl();
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch (_) {}
        reject(new M365CopilotError("Relay connection timeout — is the relay server running?"));
      }
    }, timeoutMs);

    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.on("error", (e) => {
      clearTimeout(timer);
      const msg = e?.message || e?.code || "unknown";
      if (msg.includes("ECONNREFUSED") || msg.includes("ECONNREFUSED")) {
        reject(new M365CopilotError("M365 relay not running. Start it: node index.js serve"));
      } else {
        reject(new M365CopilotError(`Relay connection failed: ${msg}`));
      }
    });
  });
}

// ── Shared connection pool (one persistent relay WS per conversation) ──
let _sharedWs = null;
let _sharedModel = null;
let _sendGate = Promise.resolve();

async function getSharedConnection() {
  if (_sharedWs && _sharedWs.readyState === WebSocket.OPEN) return _sharedWs;
  if (_sharedWs) { try { _sharedWs.close(); } catch {} _sharedWs = null; }
  _sharedWs = await connectRelay();
  _sharedModel = null;
  return _sharedWs;
}

export async function m365ChatCompletion(modelId, messages) {
  const payload = buildMessagesPayload(messages);
  const chunks = [];
  for await (const chunk of relayChatStream(payload, modelId)) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

export async function* m365ChatCompletionStream(modelId, messages) {
  const payload = buildMessagesPayload(messages);
  yield* relayChatStream(payload, modelId);
}

async function* relayChatStream(payload, modelId) {
  const relayModel = getM365RelayModel(modelId);
  const text = buildM365ChatText(payload);

  // Serialize access to the shared connection
  const prevGate = _sendGate;
  let resolveGate;
  _sendGate = new Promise(r => { resolveGate = r; });
  await prevGate;

  try {
    const ws = await getSharedConnection();
    const modelChanged = _sharedModel && _sharedModel !== relayModel;

    const pending = [];
    let done = false;
    let errorMsg = null;
    let pushResolve = null;
    let chatSent = false;
    let fullText = null;
    let yieldedAny = false;

    function pushItem(text) {
      if (text == null) return;
      pending.push(text);
      if (pushResolve) { const r = pushResolve; pushResolve = null; r(); }
    }

    function onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      if (msg.type === "ready") {
        if (!chatSent) {
          chatSent = true;
          ws.send(JSON.stringify({ type: "chat", text }));
        }
      } else if (msg.type === "sent") {
        // chat sent acknowledgement — ignore
      } else if (msg.type === "delta" && msg.text !== undefined) {
        if (!fullText) {
          yieldedAny = true;
          pushItem(msg.text.replace(/^\[COPILOT\]\s*/, ""));
        }
      } else if (msg.type === "message" && msg.text) {
        fullText = msg.text.replace(/^\[COPILOT\]\s*/, "");
        // Full authoritative response — discard partial deltas and use this
        pending.length = 0;
        idx = 0;
        pushItem(fullText);
      } else if (msg.type === "done") {
        if (!fullText && !yieldedAny) {
          // No response — let the final fallback handle it
        }
        done = true;
        if (pushResolve) { const r = pushResolve; pushResolve = null; r(); }
      } else if (msg.type === "error") {
        errorMsg = msg.message;
        done = true;
        if (pushResolve) { const r = pushResolve; pushResolve = null; r(); }
      }
    }

    function onClose() {
      done = true;
      _sharedWs = null;
      _sharedModel = null;
      if (pushResolve) { const r = pushResolve; pushResolve = null; r(); }
    }

    function onError(e) {
      errorMsg = e?.message || "Relay connection lost";
      done = true;
      _sharedWs = null;
      _sharedModel = null;
      if (pushResolve) { const r = pushResolve; pushResolve = null; r(); }
    }

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);

    // Send new session only when model changes or connection is fresh
    if (!_sharedModel || modelChanged) {
      _sharedModel = relayModel;
      ws.send(JSON.stringify({ type: "new", model: relayModel }));
    } else {
      // Reusing existing session — send chat directly
      chatSent = true;
      ws.send(JSON.stringify({ type: "chat", text }));
    }

    let idx = 0;
    while (true) {
      if (errorMsg) {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
        throw new M365CopilotError(errorMsg);
      }

      while (idx < pending.length) {
        yield pending[idx++];
      }

      if (done) break;

      await new Promise((resolve) => { pushResolve = resolve; });
    }

    // Yield any final deltas that arrived after done
    while (idx < pending.length) {
      yield pending[idx++];
    }

    // Fallback: yield full message if nothing was streamed
    if (!yieldedAny && fullText && idx === 0) {
      yield fullText;
    }

    // Clean up listeners but keep WS alive for next turn
    ws.off("message", onMessage);
    ws.off("close", onClose);
    ws.off("error", onError);
  } finally {
    resolveGate();
  }
}
