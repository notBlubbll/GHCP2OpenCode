// Cross-runtime compatibility polyfill
if (typeof Bun === 'undefined') {
  globalThis.Bun = {
    env: process.env,
  };
}

import { ModelConcurrencyManager } from "./concurrency.js";
import { compressToolDefinitions } from "./token-optimizer.js";
import { isM365Available, getM365Models } from "./m365-client.js";
import { log, warn, error, reqLog } from "./logger.js";

// ── Optimized HTTP client with connection pooling (copilot-proxy pattern) ──
let _globalAgent = null;

async function _getAgent() {
  if (_globalAgent) return _globalAgent;
  try {
    const undici = await import("undici");
    _globalAgent = new undici.Agent({
      connections: 50,              // MaxIdleConnsPerHost equivalent
      keepAliveTimeout: 90_000,     // 90s IdleConnTimeout
      keepAliveMaxTimeout: 600_000, // 10min max
      pipelining: 1,
    });
    return _globalAgent;
  } catch {
    return null;
  }
}

export async function fetchWithAgent(url, init = {}) {
  const agent = await _getAgent();
  if (agent) init.dispatcher = agent;
  return fetch(url, init);
}

const FREE_TIER_MODELS = [
  { id: "big-pickle", name: "Big Pickle", family: "big-pickle", tools: true, vision: true },
  { id: "minimax-m2.5-free", name: "MiniMax M2.5 Free", family: "minimax-free", tools: true, vision: true },
  { id: "nemotron-3-super-free", name: "Nemotron 3 Super Free", family: "nemotron-free", tools: true, vision: true },
  { id: "ring-2.6-1t-free", name: "Ring 2.6 1T Free", family: "ring-free", tools: true, vision: false },
  // Pollinations (pol/) — free, no key needed — all map to openai backend
  { id: "pol/openai-fast", name: "Pollinations GPT-OSS 20B", family: "poll-gptoss", context: 131072, tools: true, vision: false, _poll: true, _pollModel: "openai" },
  // Cosplay aliases — LLM roleplays the model name, same openai-fast backend
  { id: "pol/GPT-5", name: "Pollinations GPT-5", family: "poll-gpt", context: 131072, tools: true, vision: false, _poll: true, _pollCosplay: true, _pollModel: "openai" },
  { id: "pol/Claude", name: "Pollinations Claude", family: "poll-claude", context: 200000, tools: true, vision: false, _poll: true, _pollCosplay: true, _pollModel: "openai" },
  { id: "pol/Gemini", name: "Pollinations Gemini", family: "poll-gemini", context: 1048576, tools: true, vision: false, _poll: true, _pollCosplay: true, _pollModel: "openai" },
  { id: "pol/DeepSeek", name: "Pollinations DeepSeek", family: "poll-deepseek", context: 131072, tools: true, vision: false, _poll: true, _pollCosplay: true, _pollModel: "openai" },
  { id: "pol/Llama-4", name: "Pollinations Llama 4", family: "poll-llama", context: 131072, tools: true, vision: false, _poll: true, _pollCosplay: true, _pollModel: "openai" },
  { id: "pol/Mistral", name: "Pollinations Mistral", family: "poll-mistral", context: 131072, tools: true, vision: false, _poll: true, _pollCosplay: true, _pollModel: "openai" },
];

function fmtParamSize(val) {
  if (!val) return "";
  const s = String(val).trim();
  // Already formatted (contains M, B, K, etc.)
  if (/[MBK]/.test(s.toUpperCase())) return s;
  const n = parseFloat(s);
  if (isNaN(n)) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return s;
}

function buildFreeTierModels() {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const allModels = { ...((_mdCache && _mdCache["opencode-go"]?.models) || {}), ...((_mdCache && _mdCache["opencode"]?.models) || {}) };
  const active = FREE_TIER_MODELS.filter(m => {
    if (m._active === false) return false;
    if (m._poll && !config.showPollModels) return false;
    if (m._pollCosplay && config.hidePollCosplay) return false;
    if (allModels[m.id]?.status === "deprecated") return false;
    return true;
  });
  return active
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map(m => {
      const mdModel = allModels[m.id];
      return {
      name: m.name,
      model: `${m.id}:latest`,
      modified_at: now,
      size: 0,
      digest: m.id,
      maxParams: mdModel?.limit?.context || m.context || "",
      details: {
        parent_model: "",
        format: "gguf",
        family: m.family,
        families: [m.family],
              parameter_size: fmtParamSize(mdModel?.parameter_size || mdModel?.parameter_count || inferParameterSize(m.id)) || "",
        quantization_level: inferQuantization(m.id),
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
  log("[models] pinging free models...");
  const results = await Promise.all(FREE_TIER_MODELS.map(async (m) => {
    if (m._poll) {
      // Pollination models don't go through OpenCode free API — skip ping
      m._active = true;
      log(`[models]   ${m.id} - SKIP (poll)`);
      return true;
    }
    const { ok, ms } = await pingFreeModel(m);
    m._active = ok;
    log(`[models]   ${m.id} - ${ok ? "OK" : "OFFLINE"} (${ms}ms)`);
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
  return FREE_TIER_MODELS.some(m => m.id.toLowerCase() === clean);
}

export function isPollModel(id) {
  const clean = (id || "").split(":")[0].trim();
  return FREE_TIER_MODELS.some(m => m._poll && m.id.toLowerCase() === clean.toLowerCase());
}

export function isSeparator(id) {
  const clean = (id || "").split(":")[0].trim().toLowerCase();
  return clean === SEP_FREE || clean === SEP_PAID || clean === SEP_FREE_P || clean === SEP_M365 ||
    clean === "== free ==" || clean === "== premium ==" || clean === "== poll ==" || clean === "== m365 ==";
}

const SEP_FREE = "(free)";
const SEP_PAID = "(go)";
const SEP_FREE_P = "(free_p)";
const SEP_M365 = "(m365)";

const config = {
  get apiKey() { return Bun.env.OPENCODE_API_KEY ?? ""; },
  get hasKey() {
    if (Bun.env.OPENCODE_API_KEYS) {
      try { return JSON.parse(Bun.env.OPENCODE_API_KEYS).some(k => k.length > 5); } catch {}
    }
    if (Bun.env.OPENCODE_API_KEY && Bun.env.OPENCODE_API_KEY.length > 5) return true;
    return false;
  },
  baseUrl: Bun.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  baseUrlFree: Bun.env.OPENCODE_BASE_FREE_URL ?? "https://opencode.ai/zen/v1",
  baseUrlPoll: "https://text.pollinations.ai/openai",
  host: Bun.env.SERVER_HOST ?? "127.0.0.1",
  port: parseInt(Bun.env.SERVER_PORT ?? "11434", 10),
  defaultModel: Bun.env.DEFAULT_MODEL ?? "big-pickle",
  get defaultTemperature() {
    const t = parseFloat(Bun.env.DEFAULT_TEMPERATURE);
    return isNaN(t) ? null : t;
  },
  get requestLog() {
    const v = Bun.env.REQUEST_LOG;
    return v === undefined ? true : v === "true" || v === "1";
  },
  get hideFree() {
    return Bun.env.HIDE_FREE === "true" || Bun.env.HIDE_FREE === "1";
  },
  get showPollModels() {
    const v = Bun.env.SHOW_POLL_MODELS;
    return v === undefined ? true : v === "true" || v === "1";
  },
  get hidePollCosplay() {
    const v = Bun.env.HIDE_POLL_COSPLAY;
    return v === undefined ? true : v === "true" || v === "1";
  },
  get compressionLevel() {
    return Bun.env.COMPRESSION_LEVEL ?? "auto";
  },
  get forceAllCapabilities() {
    return (Bun.env.FORCE_ALL_CAPABILITIES ?? "true") !== "false";
  },
  get forceContextLength() {
    const v = Bun.env.FORCE_CONTEXT_LENGTH;
    return v ? Number(v) : 0;
  },
  get defaultContextLength() {
    return Number(Bun.env.DEFAULT_CONTEXT_LENGTH ?? "131072");
  },
  get modelMetadataOverrides() {
    const raw = Bun.env.MODEL_METADATA_JSON;
    if (!raw?.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch { return {}; }
  },
  get passthroughBaseUrl() {
    return Bun.env.PASSTHROUGH_BASE_URL ?? "";
  },
  get maxRetries() {
    return Math.max(0, parseInt(Bun.env.RETRY_MAX || "3", 10));
  },
  get keyRevalidationMs() {
    return parseInt(Bun.env.KEY_REVALIDATION_INTERVAL || "300000", 10);
  },
};

export function setApiKey(key) { Bun.env.OPENCODE_API_KEY = key; }

// ── Key rotation with ApiBalancer ──

const COOLDOWN_429_FIRST = 5 * 60 * 60 * 1000;  // 5 hours
const COOLDOWN_429_SECOND = 7 * 24 * 60 * 60 * 1000;  // 1 week
const CONSECUTIVE_429_THRESHOLD = 10;

let _keys = [];
let _balancer = null;
const _key429Count = new Map();  // key → consecutive 429 count

function cacheDir() {
  const base = Bun.env.OPENCODE_CACHE_DIR || (typeof process !== 'undefined' ? process.cwd() : ".");
  const dir = `${base}/.cache`;
  try {
    if (_fs) _fs.mkdirSync(dir, { recursive: true });
    else if (typeof require !== 'undefined') require("node:fs").mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

const _keyStatePath = `${cacheDir()}/key-state.json`;

function loadKeyState() {
  try {
    if (!_fs) return {};
    if (!_fs.existsSync(_keyStatePath)) return {};
    const data = JSON.parse(_fs.readFileSync(_keyStatePath, "utf8"));
    log(`[keys] loaded state from ${_keyStatePath}`);
    return data;
  } catch {
    return {};
  }
}

let _lastKeyStateHash = "";

function saveKeyState() {
  if (!_fs) return;
  try {
    const now = Date.now();
    const keys = {};
    for (const key of _keys) {
      const short = `${key.slice(0, 6)}...${key.slice(-4)}`;
      keys[short] = {
        consecutive429: _key429Count.get(key) || 0,
      };
      if (_balancer) {
        if (_balancer.cooldownUntil.has(key)) {
          const until = _balancer.cooldownUntil.get(key);
          if (until > now) {
            keys[short].cooldownUntil = new Date(until).toISOString();
            keys[short].cooldownReason = _balancer.cooldownReason.get(key) || "429";
          }
        }
      }
    }
    // Skip write if state hasn't changed since last save
    const newHash = JSON.stringify(keys);
    if (newHash === _lastKeyStateHash) return;
    _lastKeyStateHash = newHash;
    _fs.writeFileSync(_keyStatePath, JSON.stringify({ keys, updatedAt: isoNow() }, null, 2));
    log(`[keys] state saved to ${_keyStatePath}`);
  } catch (e) {
    error(`[keys] save state failed: ${e.message}`);
  }
}

function loadKeys() {
  let newKeys = [];
  if (Bun.env.OPENCODE_API_KEYS) {
    try { newKeys = JSON.parse(Bun.env.OPENCODE_API_KEYS).filter(k => k.length > 5); } catch {}
  } else if (Bun.env.OPENCODE_API_KEY && Bun.env.OPENCODE_API_KEY.length > 5) {
    newKeys = [Bun.env.OPENCODE_API_KEY];
  }

  // Compare by content, not reference — avoids recreating balancer on every call
  const keysChanged = _keys.length !== newKeys.length || _keys.some((k, i) => k !== newKeys[i]);
  _keys = newKeys;

  if (_keys.length > 0 && (!_balancer || keysChanged)) {
    const savedState = loadKeyState();
    _balancer = new ApiBalancer(_keys, savedState);
  }
}

class ApiBalancer {
  constructor(keys, savedState = {}) {
    this.keys = keys;
    this.pool = [];
    this.cooldownUntil = new Map();   // key → cooldown-until timestamp
    this.cooldownReason = new Map();  // key → "401" | "429"
    this._restoreState(savedState);
  }

  _restoreState(savedState) {
    const keyMap = {};
    for (const k of this.keys) {
      const short = `${k.slice(0, 6)}...${k.slice(-4)}`;
      keyMap[short] = k;
    }
    let restoredCooldowns = 0;
    let skippedExpired = 0;
    for (const [short, info] of Object.entries(savedState.keys || {})) {
      const fullKey = keyMap[short];
      if (!fullKey) { log(`[keys] state has ${short} but no matching key — skipping`); continue; }
      if (info.cooldownUntil || info.bannedUntil) {
        const until = new Date(info.cooldownUntil || info.bannedUntil).getTime();
        if (until > Date.now()) {
          this.cooldownUntil.set(fullKey, until);
          if (info.cooldownReason) this.cooldownReason.set(fullKey, info.cooldownReason);
          restoredCooldowns++;
        } else {
          skippedExpired++;
        }
      }
      if (info.consecutive429) {
        _key429Count.set(fullKey, info.consecutive429);
      }
    }
    if (restoredCooldowns > 0) log(`[keys] restored ${restoredCooldowns} cooldown(s) from cache (${skippedExpired} expired)`);
  }

  _refillPool() {
    const now = Date.now();
    this.pool = [];
    for (const key of this.keys) {
      if (this.cooldownUntil.has(key) && this.cooldownUntil.get(key) > now) continue;
      this.pool.push(key);
    }
    if (this.pool.length === 0) {
      // All keys in cooldown — use the one with earliest expiry
      let earliestKey = null;
      let earliestTime = Infinity;
      for (const [key, until] of this.cooldownUntil.entries()) {
        if (until < earliestTime) {
          earliestTime = until;
          earliestKey = key;
        }
      }
      if (earliestKey) {
        this.pool = [earliestKey];
      } else {
        this.pool = [...this.keys];
      }
    }
    // Shuffle
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
    }
  }

  getNextKey() {
    if (this.pool.length === 0) {
      this._refillPool();
    }
    if (this.pool.length === 0) return "";
    return this.pool.pop();
  }

  mark401(key, reason = "") {
    const cdMs = Math.max(3600000, parseInt(Bun.env.OPENCODE_401_COOLDOWN_MS || "3600000", 10)); // 1 hour default
    const until = Date.now() + cdMs;
    this.cooldownUntil.set(key, until);
    this.cooldownReason.set(key, "401");
    const short = `${key.slice(0, 6)}...${key.slice(-4)}`;
    const hrs = Math.round(cdMs / 3600000);
    warn(`[keys] ${short} in cooldown for ~${hrs}h (401)${reason ? ` — ${reason}` : ""} (until ${new Date(until).toLocaleString()})`);
    saveKeyState();
  }

  // mark429 with optional dynamic reset seconds from upstream response
  // Pass resetSeconds to use upstream quota reset as cooldown duration instead of hardcoded values
  mark429(key, resetSeconds = 0) {
    const count = (_key429Count.get(key) || 0) + 1;
    _key429Count.set(key, count);
    const short = `${key.slice(0, 6)}...${key.slice(-4)}`;
    this.cooldownReason.set(key, "429");

    // Start cooldown immediately if we have upstream timing (e.g. "Resets in 1 day"), or after threshold
    if (resetSeconds > 0 || count >= CONSECUTIVE_429_THRESHOLD) {
      let cdMs;
      let label;

      if (resetSeconds > 0) {
        cdMs = resetSeconds * 1000;
        label = cdMs >= 86400000 ? `~${Math.round(cdMs / 86400000)}d` : `~${Math.round(cdMs / 3600000)}h`;
      } else if (this.cooldownUntil.has(key) && this.cooldownUntil.get(key) > Date.now()) {
        cdMs = COOLDOWN_429_SECOND;
        label = '~1 week';
      } else {
        cdMs = COOLDOWN_429_FIRST;
        label = '~5h';
      }

      const until = Date.now() + cdMs;
      this.cooldownUntil.set(key, until);
      this.cooldownReason.set(key, "429");
      warn(`[keys] ${short} in cooldown for ${label}${resetSeconds > 0 ? ` (upstream)` : ` after ${count} consecutive 429s`} (until ${new Date(until).toLocaleString()})`);
    }
    saveKeyState();
  }

  // mark401: key returned 401 (auth denied / invalid). Persist cooldown with error message.
  mark401(key, reason = "") {
    const cdMs = Math.max(3600000, parseInt(Bun.env.OPENCODE_401_COOLDOWN_MS || "3600000", 10)); // 1 hour default
    const until = Date.now() + cdMs;
    this.cooldownUntil.set(key, until);
    this.cooldownReason.set(key, "401");
    const short = `${key.slice(0, 6)}...${key.slice(-4)}`;
    const hrs = Math.round(cdMs / 3600000);
    warn(`[keys] ${short} in cooldown for ~${hrs}h (401)${reason ? ` — ${reason}` : ""} (until ${new Date(until).toLocaleString()})`);
    saveKeyState();
  }

  markSuccess(key, reason = null) {
    _key429Count.set(key, 0);
    if (this.cooldownUntil.has(key)) {
      this.cooldownUntil.delete(key);
      this.cooldownReason.delete(key);
      const short = `${key.slice(0, 6)}...${key.slice(-4)}`;
      log(`[keys] ${short} released from cooldown (successful request)`);
    } else if (reason) {
      const short = `${key.slice(0, 6)}...${key.slice(-4)}`;
      log(`[keys] ${short} verified — ${reason}`);
    }
    saveKeyState();
  }

  getStatus() {
    const now = Date.now();
    return this.keys.map(k => {
      const short = `${k.slice(0, 6)}...${k.slice(-4)}`;
      const consecutive429 = _key429Count.get(k) || 0;
      let status = "active";
      let releaseAt = null;
      let reason = null;
      if (this.cooldownUntil.has(k)) {
        const until = this.cooldownUntil.get(k);
        if (until > now) {
          reason = this.cooldownReason.get(k) || null;
          status = reason === "401" ? "auth_denied" : "cooldown";
          releaseAt = new Date(until).toISOString();
        }
      }
      return { keyPrefix: short, status, reason, consecutive429, releaseAt };
    });
  }
}

function withKey() {
  loadKeys();
  if (!_balancer) return _keys[0] || "";
  const key = _balancer.getNextKey();
  return key || _keys[0] || "";
}

function report429(key, resetSeconds = 0) {
  if (key && _balancer) {
    _balancer.mark429(key, resetSeconds);
  }
}

function reportKeySuccess(key, reason = null) {
  if (key && _balancer) {
    _balancer.markSuccess(key, reason);
  }
}

const _keyValidated = new Map();

function markKeyValid(key) {
  if (key) _keyValidated.set(key, Date.now());
}

function lastKeyValidation(key) {
  return _keyValidated.get(key) || 0;
}

function isKeyStale(key) {
  const last = lastKeyValidation(key);
  return last === 0 || (Date.now() - last) > config.keyRevalidationMs;
}

export function getKeyStatus() {
  loadKeys();
  if (!_balancer) {
    return _keys.map(k => ({
      keyPrefix: k ? `${k.slice(0, 6)}...${k.slice(-4)}` : "none",
      status: "active",
      consecutive429: _key429Count.get(k) || 0,
    }));
  }
  return _balancer.getStatus();
}

export function rotateKey() {
  // ApiBalancer handles rotation via pool — no explicit rotation needed
  // This is kept for backward compatibility
  if (_balancer) {
    _balancer._refillPool();
  }
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
  _diskCachePath = `${cacheDir()}/models.json`;
  return _diskCachePath;
}

let _crypto = null;
async function _loadCrypto() {
  if (!_crypto) _crypto = await import("node:crypto");
  return _crypto;
}

function keyHash() {
  const keys = [];
  if (Bun.env.OPENCODE_API_KEY) keys.push(Bun.env.OPENCODE_API_KEY);
  if (Bun.env.OPENCODE_API_KEYS) {
    try { keys.push(...JSON.parse(Bun.env.OPENCODE_API_KEYS)); } catch {}
  }
  // Also parse .env file directly (Node.js might not auto-load it)
  try {
    if (_fs) {
      const envPath = `${process?.cwd?.() || "."}/.env`;
      if (_fs.existsSync(envPath)) {
        const envRaw = _fs.readFileSync(envPath, "utf8");
        for (const line of envRaw.split("\n")) {
          const m = line.match(/^\s*OPENCODE_API_KEYS?\s*=\s*(.+)/);
          if (m) {
            const val = m[1].replace(/^["']|["']$/g, "").trim();
            if (val && val !== '""' && val !== "''") {
              if (val.startsWith("[")) {
                try { keys.push(...JSON.parse(val)); } catch { keys.push(val); }
              } else {
                keys.push(val);
              }
            }
          }
        }
      }
    }
  } catch {}
  const deduped = [...new Set(keys)].sort();
  if (!deduped.length) return "no-key";
  const combined = deduped.join("");
  if (_crypto) return _crypto.createHash("sha256").update(combined).digest("hex");
  let h = 0;
  for (let i = 0; i < combined.length; i++) {
    h = ((h << 5) - h + combined.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function getKeyHashPath() {
  return `${cacheDir()}/keyhash.json`;
}

function loadKeyHashFromDisk() {
  try {
    if (!_fs) { log("[keys] no fs module loaded"); return null; }
    const path = getKeyHashPath();
    const data = JSON.parse(_fs.readFileSync(path, "utf8"));
    log(`[keys] loaded hash from ${path}: ${(data.h || "").slice(0, 5)}`);
    return data.h || null;
  } catch (e) {
    log(`[keys] no hash file yet (${e.message})`);
    return null;
  }
}

function saveKeyHashToDisk(h) {
  if (!_fs) { log("[keys] no fs module loaded"); return; }
  try {
    const path = getKeyHashPath();
    const prev = loadKeyHashFromDisk();
    if (prev === h) return;
    cacheDir();
    _fs.writeFileSync(path, JSON.stringify({ h }));
    log(`[keys] saved hash ${h.slice(0, 5)} to ${path}`);
  } catch (e) {
    log(`[keys] save failed: ${e.message}`);
  }
}

let _lastKeyHash = null;
async function checkKeyChanged() {
  await _loadCrypto();
  const h = keyHash();
  if (!_lastKeyHash) {
    _lastKeyHash = loadKeyHashFromDisk();
  }
  if (_lastKeyHash !== null && _lastKeyHash !== h) {
    log(`[keys] changed: ${(_lastKeyHash || "").slice(0, 5)} → ${h.slice(0, 5)} — will ping to verify each key`);
    _lastKeyHash = h;
    saveKeyHashToDisk(h);
    return true;
  }
  _lastKeyHash = h;
  return false;
}

function freeTierHash() {
  const ids = FREE_TIER_MODELS.map(m => m.id).join("|");
  if (_crypto) return _crypto.createHash("sha256").update(ids).digest("hex").slice(0, 12);
  let h = 0;
  for (let i = 0; i < ids.length; i++) { h = ((h << 5) - h + ids.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

function loadModelsFromDisk() {
  try {
    if (!_fs) return false;
    // Require key hash file to exist — if missing, force refresh
    if (!_fs.existsSync(getKeyHashPath())) {
      log("[models] key hash file missing — forcing refresh");
      return false;
    }
    const data = JSON.parse(_fs.readFileSync(getDiskPath(), "utf8"));
    if (data._models?.length) {
      // Invalidate cache if FREE_TIER_MODELS changed (new models added/removed)
      if (!data._freeTierHash || data._freeTierHash !== freeTierHash()) {
        log("[models] free tier models changed — forcing refresh");
        return false;
      }
      // Invalidate cache if M365 token path changed (newly set, removed, or token refreshed)
      const cachedHasM365 = data._models.some(m => (m.model || "").replace(":latest", "").startsWith(SEP_M365));
      const envHasM365 = !!(Bun.env.M365CO_PORT || Bun.env.M365C_RELAY_URL);
      if (envHasM365 !== cachedHasM365) {
        log(`[models] M365 ${envHasM365 ? "newly set" : "removed"} — forcing refresh`);
        return false;
      }
      // M365 is enabled via relay — availability handled by m365-client.js
      _models = data._models;
      _modelMap = data._modelMap || {};
      _nameToId = data._nameToId || {};
      // Strip cosplay models from cached data when hidden
      if (config.hidePollCosplay) {
        const cosplayIds = new Set(FREE_TIER_MODELS.filter(m => m._pollCosplay).map(m => m.id.toLowerCase()));
        _models = _models.filter(m => {
          const rawId = (m.model || "").replace(":latest", "").toLowerCase();
          return !cosplayIds.has(rawId);
        });
      }
      log(`[models] loaded ${_models.length} from disk cache`);
      return true;
    }
  } catch {}
  return false;
}

async function saveModelsToDisk() {
  try {
    await _loadFs();
    await _loadCrypto();
    cacheDir();
    const path = getDiskPath();
    if (!_models?.length) return;
    const diskData = { _models, _modelMap, _nameToId, _keyHash: keyHash(), _freeTierHash: freeTierHash() };
    _fs.writeFileSync(path, JSON.stringify(diskData));
    log(`[cache] saved to ${path}`);
  } catch (e) {
    error(`[cache] save failed: ${e.message}`);
  }
}

async function fetchModelsDev() {
  if (_mdCache) return _mdCache;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch("https://models.dev/api.json", { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return {};
    const data = await resp.json();
    _mdCache = data;
    return data;
  } catch {
    return {};
  }
}

async function fetchModels() {
  // Serialize concurrent fetchModels calls (background fetch + refreshModels)
  const prevGate = _fetchModelsGate;
  let resolveGate;
  _fetchModelsGate = new Promise(r => { resolveGate = r; });
  await prevGate;
  try {

  const start = Date.now();
  const md = await fetchModelsDev();
  const allModels = { ...(md["opencode-go"]?.models || {}), ...(md["opencode"]?.models || {}) };
  const goModels = md["opencode-go"]?.models || {};
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  // Always start with free tier models (alphabetical)
  const models = [];

  // M365 Copilot (optional — always at top if available)
  let m365Count = 0;
  const m365Avail = await isM365Available();
  if (m365Avail) {
    const m365Models = await getM365Models();
    if (m365Models.length) {
      models.push(sepModel(SEP_M365, "== M365 =="));
      for (const m365Model of m365Models) {
        models.push({
          name: m365Model.name,
          model: `${m365Model.id}:latest`,
          modified_at: now,
          size: 0,
          digest: m365Model.id,
          maxParams: "",
          details: {
            parent_model: "",
            format: "gguf",
            family: m365Model.family,
            families: [m365Model.family],
            parameter_size: "",
            quantization_level: "F16",
            tools: false,
            vision: false,
            supports_tools: false,
            supports_function_calling: false,
            supports_vision: false,
          },
          capabilities: { tools: false, vision: false, function_calling: false, tool_calling: false },
          supports_tools: false,
          supports_function_calling: false,
        });
        _modelMap[m365Model.id.toLowerCase()] = { id: m365Model.id, name: m365Model.name, tools: false, vision: false, _m365: true };
        _nameToId[m365Model.name.toLowerCase()] = m365Model.id;
        m365Count++;
      }
    }
  }

  if (!config.hideFree) {
    const allFree = buildFreeTierModels();
    const regFree = allFree.filter(m => !isPollModel(m.model));
    const pollFree = allFree.filter(m => isPollModel(m.model));
    if (regFree.length) {
      models.push(sepModel(SEP_FREE, "== FREE =="));
      models.push(...regFree);
    }
    if (pollFree.length && config.showPollModels) {
      models.push(sepModel(SEP_FREE_P, "== POLL =="));
      models.push(...pollFree);
    }
  }
  const freeSet = new Set(FREE_TIER_MODELS.map(m => m.id));
  let paidFrom = "";
  let paidCount = 0;

  // If API key is set, also fetch paid models
  if (_paidGoData?.data?.length && _paidKeyUsable) {
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
              family: mdModel?.name || inferFamily(m.id),
              families: [mdModel?.name || inferFamily(m.id)],
        parameter_size: fmtParamSize(mdModel?.parameter_size || mdModel?.parameter_count || inferParameterSize(m.id)) || "",
              quantization_level: inferQuantization(m.id),
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

        paidModels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        paidCount = paidModels.length;
        paidFrom = "OpenCode API";

        models.push(sepModel(SEP_PAID, "== PREMIUM =="));
        models.push(...paidModels);
      } catch (e) {
        error(`[models] Failed to build paid models: ${e.message}`);
    }
  }

  // Always register free models in the maps
  for (const m of FREE_TIER_MODELS) {
    _modelMap[m.id.toLowerCase()] = { id: m.id, name: m.name, tools: m.tools, vision: m.vision };
    _nameToId[m.name.toLowerCase()] = m.id;
  }

  _models = models;
  const elapsed = Date.now() - start;
  const freeCount = config.hideFree ? 0 : FREE_TIER_MODELS.length;
  const totalReal = models.filter(m => !isSeparator(m.model)).length;
  const paidLabel = paidCount > 0 ? (freeCount > 0 ? ` (${freeCount} free + ${paidCount} paid)` : ` (${paidCount} paid)`) : "";
  const sourceLabel = paidFrom ? ` from ${paidFrom}` : "";
  log(`[models] ${totalReal} total${paidLabel}${sourceLabel} (${elapsed}ms)`);
  return _models;

  } finally {
    resolveGate();
  }
}

export async function initModels() {
  await _loadFs();
  await _loadCrypto();
  await checkKeyChanged();
  // Always try disk cache first — better than empty
  if (loadModelsFromDisk()) {
    log("[models] using disk cache, updating in background");
  } else {
    log("[models] no cache — building from built-in data");
    await fetchModels();
    await saveModelsToDisk();
    saveKeyHashToDisk(keyHash());
  }
  // Quick connectivity ping with free model
  try {
    const p = await fetch(`${config.baseUrlFree}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "tell me a joke" }], max_tokens: 80 }),
    });
    const txt = p.ok ? "ok" : (p.status === 401 ? "key denied" : "offline");
    log(`[models] ping big-pickle → ${p.status} ${txt}`);
  } catch { log("[models] ping big-pickle → unreachable"); }
  // Fetch paid models async (don't block startup)
  _bgFetch = fetchGoModelsRaw().then(async () => {
    if (_paidGoData?.data?.length) {
      await fetchModels();
      await saveModelsToDisk();
      saveKeyHashToDisk(keyHash());
    } else if (!_paidKeyUsable && _models) {
      await fetchModels();
    }
  }).catch(() => {});
  return _models;
}

let _bgFetch = null;
export function bgFetchDone() { return _bgFetch; }

export function getModels() {
  if (_models) return _models;
  return fetchModels();
}

let _paidGoData = null;
let _paidKeyUsable = true;
let _fetchModelsGate = Promise.resolve();

async function fetchGoModelsRaw() {
  const keys = [];
  if (Bun.env.OPENCODE_API_KEYS) {
    try { keys.push(...JSON.parse(Bun.env.OPENCODE_API_KEYS).filter(k => k.length > 5)); } catch {}
  } else if (Bun.env.OPENCODE_API_KEY && Bun.env.OPENCODE_API_KEY.length > 5) {
    keys.push(Bun.env.OPENCODE_API_KEY);
  }
  log(`[keys] found ${keys.length} key(s) in env`);
  loadKeys();

  // Build cooldown map from key-state.json directly (safety net)
  const cooldownFromDisk = new Map();
  try {
    if (_fs && _fs.existsSync(_keyStatePath)) {
      const state = JSON.parse(_fs.readFileSync(_keyStatePath, "utf8"));
      const keyMap = {};
      for (const k of keys) {
        keyMap[`${k.slice(0, 6)}...${k.slice(-4)}`] = k;
      }
      for (const [short, info] of Object.entries(state.keys || {})) {
        const fullKey = keyMap[short];
        if (!fullKey) continue;
        if (info.cooldownUntil || info.bannedUntil) {
          const until = new Date(info.cooldownUntil || info.bannedUntil).getTime();
          if (until > Date.now()) cooldownFromDisk.set(fullKey, until);
        }
      }
    }
  } catch {}

  // Skip if all keys are still in cooldown
  const now = Date.now();
  function keyInCooldown(key) {
    const balancerCooldown = _balancer?.cooldownUntil?.get(key);
    if (balancerCooldown && balancerCooldown > now) return true;
    const diskCooldown = cooldownFromDisk.get(key);
    if (diskCooldown && diskCooldown > now) return true;
    return false;
  }
  const allCooldown = keys.length > 0 && keys.every(k => keyInCooldown(k));
  if (allCooldown) {
    const cooldownUntilVal = _balancer?.cooldownUntil?.get(keys[0]) || cooldownFromDisk.get(keys[0]) || 0;
    const remaining = Math.round((cooldownUntilVal - now) / 1000);
    log(`[keys] all keys in cooldown (~${remaining}s) — skipping paid models`);
    _paidKeyUsable = false;
    _paidGoData = null;
    return null;
  }

  // Only verify all keys when the key set actually changed
  let keysChanged = false;
  try {
    const curHash = keyHash();
    const savedHash = loadKeyHashFromDisk();
    keysChanged = (savedHash !== curHash);
  } catch {}

  if (!keysChanged) {
    if (_paidGoData) {
      log(`[keys] key set unchanged — ${_paidGoData?.data?.length || 0} paid models cached, skipping verification`);
      return _paidGoData;
    }
    // No paid data cached yet — quick model fetch with a known-good key (no per-key verification)
    const bestKey = withKey();
    if (bestKey && !keyInCooldown(bestKey)) {
      try {
        const quickResp = await fetch(`${config.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${bestKey}` },
        });
        if (quickResp.ok) {
          _paidGoData = await quickResp.json();
          _paidKeyUsable = true;
          log(`[models] key set unchanged — quick model fetch → ${_paidGoData?.data?.length || 0} paid models`);
          return _paidGoData;
        }
      } catch {}
    }
    return null;
  }

  // Key set changed — verify every key and cache results
  log(`[keys] key set changed — verifying all ${keys.length} key(s)`);

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    try {
      // Skip individual keys still in cooldown
      if (keyInCooldown(k)) {
        const cooldownUntilVal = _balancer?.cooldownUntil?.get(k) || cooldownFromDisk.get(k) || 0;
        const remaining = Math.round((cooldownUntilVal - now) / 1000);
        log(`[keys] key[${i+1}] in cooldown (~${remaining}s) — skipping`);
        continue;
      }

      // Ping first — verify inference works before fetching model list
      const PING_MODEL = "deepseek-v4-flash";
      await new Promise(r => setTimeout(r, 3000));
      try {
        const pingResp = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
          body: JSON.stringify({ model: PING_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        });
        if (pingResp.ok) {
          log(`[models] key[${i+1}] ping ${PING_MODEL} → ${pingResp.status} ok`);
          reportKeySuccess(k, "ping ok");
          // Fetch model list from first working key — verify all keys regardless
          if (!_paidGoData) {
            const goResp = await fetch(`${config.baseUrl}/models`, {
              headers: { Authorization: `Bearer ${k}` },
            });
            if (goResp.status === 401) {
              error(`[models] key[${i+1}] ping ok but model fetch → 401 (invalid)`);
            } else if (goResp.ok) {
              _paidGoData = await goResp.json();
              _paidKeyUsable = true;
              const modelCount = _paidGoData?.data?.length || 0;
              log(`[models] key[${i+1}] valid — ${modelCount} paid models`);
            }
          }
        } else if (pingResp.status === 429) {
          const txt = await pingResp.text().catch(() => "");
          let errType = "429", errMsg = "";
          try {
            const p = JSON.parse(txt);
            errType = p.error?.type || p.error?.code || errType;
            errMsg = p.error?.message || "";
            // Parse duration from message (e.g. "Resets in 1 day", "Resets in 15hr 8min", "Resets in 4 hours 30 minutes")
            let resetSec = 0;
            try {
              const dm = errMsg.match(/resets?\s+in\s+(.+?)(?:\.|$|\s+To)/i);
              if (dm) {
                const durStr = dm[1];
                let m2;
                const re = /(\d+)\s*(day|hour|hr|minute|min|second|sec)s?/gi;
                while ((m2 = re.exec(durStr)) !== null) {
                  const n = parseInt(m2[1], 10);
                  const u = m2[2].toLowerCase();
                  if (u === 'day') resetSec += n * 86400;
                  else if (u === 'hour' || u === 'hr') resetSec += n * 3600;
                  else if (u === 'minute' || u === 'min') resetSec += n * 60;
                  else if (u === 'second' || u === 'sec') resetSec += n;
                }
              }
            } catch {}
            if (resetSec > 0) {
              report429(k, resetSec);
            }
          } catch {}
          warn(`[models] key[${i+1}] ping ${PING_MODEL} → 429 (${errType}${errMsg ? `: ${errMsg}` : ""})`);
          if (keys.length <= 1) { _paidKeyUsable = false; _paidGoData = null; }
          continue;
        } else if (pingResp.status === 401 || pingResp.status === 403) {
          warn(`[models] key[${i+1}] ping → ${pingResp.status} (invalid key)`);
          continue;
        } else {
          // Model not found — fallback to first premium model
          warn(`[models] ${PING_MODEL} → ${pingResp.status} (not found?) — trying fallback model`);
          const fallResp = await fetch(`${config.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${k}` },
          });
          if (fallResp.ok) {
            const fallData = await fallResp.json();
            const fallModel = fallData?.data?.[0]?.id;
            if (fallModel) {
              try {
                const fallPing = await fetch(`${config.baseUrl}/chat/completions`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
                  body: JSON.stringify({ model: fallModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
                });
                if (fallPing.ok) {
                  warn(`[models] ${PING_MODEL} not found — verify if it's still the cheapest model`);
                  log(`[models] key[${i+1}] fallback ping ${fallModel} → ${fallPing.status} ok`);
                  reportKeySuccess(k, "fallback ping ok");
                } else if (fallPing.status === 429) {
                  const ftxt = await fallPing.text().catch(() => "");
                  let ftype = "429", fmsg = "";
                  try {
                    const fp = JSON.parse(ftxt);
                    ftype = fp.error?.type || ftype;
                    fmsg = fp.error?.message || "";
                    let fResetSec = 0;
                    try {
                      const dm = fmsg.match(/resets?\s+in\s+(.+?)(?:\.|$|\s+To)/i);
                      if (dm) {
                        const durStr = dm[1];
                        let m2;
                        const re = /(\d+)\s*(day|hour|hr|minute|min|second|sec)s?/gi;
                        while ((m2 = re.exec(durStr)) !== null) {
                          const n = parseInt(m2[1], 10);
                          const u = m2[2].toLowerCase();
                          if (u === 'day') fResetSec += n * 86400;
                          else if (u === 'hour' || u === 'hr') fResetSec += n * 3600;
                          else if (u === 'minute' || u === 'min') fResetSec += n * 60;
                          else if (u === 'second' || u === 'sec') fResetSec += n;
                        }
                      }
                    } catch {}
                    if (fResetSec > 0) {
                      report429(k, fResetSec);
                    }
                  } catch {}
                  warn(`[models] key[${i+1}] fallback ping ${fallModel} → 429 (${ftype}${fmsg ? `: ${fmsg}` : ""})`);
                  if (keys.length <= 1) { _paidKeyUsable = false; _paidGoData = null; }
                  continue;
                } else if (fallPing.status === 401 || fallPing.status === 403) {
                  warn(`[models] key[${i+1}] fallback ping → ${fallPing.status} (invalid key)`);
                  continue;
                } else {
                  warn(`[models] key[${i+1}] fallback ping ${fallModel} → ${fallPing.status}`);
                  continue;
                }
              } catch {
                warn(`[models] key[${i+1}] fallback ping ${fallModel} → unreachable`);
                continue;
              }
            }
            if (!_paidGoData) _paidGoData = fallData;
          }
          continue;
        }
      } catch {
        warn(`[models] key[${i+1}] ping ${PING_MODEL} → unreachable`);
        continue;
      }
    } catch (e) {
      error(`[models] key[${i+1}] API error: ${e.message}`);
    }
  }

  if (_paidGoData) {
    log(`[models] verified ${keys.length} key(s) — ${_paidGoData?.data?.length || 0} paid models loaded`);
    return _paidGoData;
  }
  if (keys.length) error("[models] No valid Go API key — free tier only");
  _paidGoData = null;
  return null;
}

export async function refreshModels() {
  log("[models] refreshing from API...");
  const start = Date.now();
  await checkKeyChanged();
  if (config.hideFree) log("[models] HIDE_FREE=true — skipping free model validation");
  await Promise.all([
    config.hideFree ? Promise.resolve() : validateFreeModels(),
    fetchGoModelsRaw(),
  ]);
  if (_paidGoData) {
    await fetchModels();
    await saveModelsToDisk();
  } else if (!loadModelsFromDisk()) {
    _models = [];
    await fetchModels();
  }
  saveKeyHashToDisk(keyHash());
  log(`[models] refresh done (${Date.now() - start}ms)`);
}

export function resolveModel(name) {
  let clean = name.split(":")[0].trim().toLowerCase();
  clean = clean.replace(/\s*\(free\)$/i, ""); // strip "(Free)" suffix from tag list
  
  if (isSeparator(clean)) return { id: clean, name: clean, tools: false, vision: false, separator: true };
  
  if (_modelMap[clean]) return _modelMap[clean];
  const nmId = _nameToId[clean];
  if (nmId && _modelMap[nmId.toLowerCase()]) return _modelMap[nmId.toLowerCase()];
  
  const freeMatch = FREE_TIER_MODELS.find(m => m.id.toLowerCase() === clean);
  if (freeMatch) return { id: freeMatch.id, name: freeMatch.name, tools: freeMatch.tools, vision: freeMatch.vision };
  
  return { id: clean, name: clean, tools: true, vision: false, unverified: true };
}

export function isKnownModel(id) {
  if (!id) return false;
  let clean = id.split(":")[0].trim().toLowerCase();
  clean = clean.replace(/\s*\(free\)$/i, "");
  if (isSeparator(clean)) return true;
  if (_modelMap[clean]) return true;
  if (_nameToId[clean]) return true;
  if (FREE_TIER_MODELS.find(m => m.id.toLowerCase() === clean)) return true;
  return false;
}

export function isM365Model(id) {
  if (!id) return false;
  const clean = id.split(":")[0].trim().toLowerCase();
  const info = _modelMap[clean];
  return info?._m365 === true;
}

function isoNow() { return new Date().toISOString(); }

// ── Direct OpenCode Go API calls ──

// ── API Error ──

export class APIError extends Error {
  constructor(status, body, message) {
    super(message || `API ${status}`);
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
  502: "bad_gateway",
  503: "server_overloaded",
  504: "gateway_timeout",
};

function resolvePollModelName(id) {
  const clean = (id || "").split(":")[0].trim();
  const def = FREE_TIER_MODELS.find(m => m._poll && m.id.toLowerCase() === clean.toLowerCase());
  return def?._pollModel || clean;
}

async function zenRequest(endpoint, body, opts = {}) {
  const isPoll = isPollModel(body.model);
  const isFree = !isPoll && isFreeTierModel(body.model);
  const base = isPoll ? config.baseUrlPoll : (isFree ? config.baseUrlFree : config.baseUrl);
  const url = `${base}${endpoint}`;
  const key = withKey();
  const clientTag = opts?.clientTag || "";
  
  if (isSeparator(body.model)) {
    throw new APIError(400, "", "This is a category header, not a model. Please select an actual model from the list.");
  }

  // Map poll model names to Pollinations-native model IDs
  const sendBody = { ...body };
  if (isPoll) {
    sendBody.model = resolvePollModelName(body.model);
  }
  
  const lastMsg = body.messages?.[body.messages.length - 1];
  const preview = (typeof lastMsg?.content === "string" ? lastMsg.content : "").replace(/\s+/g, " ").trim().slice(0, 60);
  const provider = isPoll ? "pol" : (isFree ? "zen" : "go");
  if (config.requestLog) {
    reqLog({ tag: clientTag, provider, model: body.model, preview: `${preview}${lastMsg?.content?.length > 60 ? "\u2026" : ""}` });
    if (!preview) {
      const fullPrompt = (body.messages || []).map(m =>
        `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`
      ).join("\n");
      log(`[${provider}] DEBUG empty prompt, full payload:\n${fullPrompt}`);
    }
  }

  const headers = {
    "Content-Type": "application/json",
  };
  
  // Poll models: no auth needed (free public API)
  // Free models: never send auth. Paid: require key.
  if (isPoll) {
    // Pollinations is a public API, no auth needed
  } else if (key && !isFree) {
    headers["Authorization"] = `Bearer ${key}`;
  } else if (!isFree) {
    throw new APIError(401, "", "No API key configured. Free tier models can be used without a key.");
  }

  const resp = await fetchWithAgent(url, { method: "POST", headers, body: JSON.stringify(sendBody), signal: opts?.signal });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    error(`[${provider}] ${resp.status}`);

    // Extract detailed error from upstream JSON responses
    let upstreamMsg = "API error";
    let code = ERROR_CODES[resp.status] || "api_error";
    let mappedStatus = resp.status;
    try {
      const parsed = JSON.parse(txt);
      upstreamMsg = parsed.error?.message || parsed.error?.code || parsed.message || parsed.detail || upstreamMsg;
      if (parsed.error?.type === "AuthError") { code = "invalid_api_key"; mappedStatus = 401; }
      if (parsed.error?.type === "ModelError") { code = "model_not_found"; mappedStatus = 404; }
      if (parsed.error?.code) code = parsed.error.code;
    } catch {}

    // Log the actual upstream error message for diagnostics
    if ((resp.status === 401 || resp.status === 403) && upstreamMsg !== "API error") {
      error(`[${provider}] 401 message: ${upstreamMsg}`);
    }

    const retries = opts.retries || 0;
    const maxRetries = opts.maxRetries ?? config.maxRetries;

    // Never retry "Service is too busy" errors — propagation not retry
    if (upstreamMsg.includes("Service is too busy")) {
      error(`[${provider}] upstream busy — not retrying`);
      throw new APIError(mappedStatus, txt, upstreamMsg);
    }

    // Retry: rotate key on auth/rate-limit errors, up to configurable max
    if (key && (resp.status === 401 || resp.status === 429) && retries < maxRetries && retries < _keys.length) {
      if (resp.status === 429) {
        // Try to extract upstream reset seconds from response body
        // Priority: monthly > weekly > rolling (only if rate-limited)
        let resetSec = 0;
        try {
          const parsed = JSON.parse(txt);
          if (parsed.monthlyUsage?.status === "rate-limited") {
            resetSec = parsed.monthlyUsage.resetInSec;
          } else if (parsed.weeklyUsage?.status === "rate-limited") {
            resetSec = parsed.weeklyUsage.resetInSec;
          } else if (parsed.rollingUsage?.status === "rate-limited") {
            resetSec = parsed.rollingUsage.resetInSec;
          }
        } catch {}
        report429(key, resetSec);
      } else {
        // Log upstream auth error detail before rotating
        if (config.requestLog) log(`[${provider}] 401 on key — rotating: ${upstreamMsg}`);
        if (_balancer) _balancer.mark401(key, upstreamMsg);
      }
      if (config.requestLog) log(`[${provider}] retry ${retries + 1}/${maxRetries} after ${resp.status}`);
      return zenRequest(endpoint, body, { ...opts, retries: retries + 1 });
    }

    // Network errors also retry up to max, with backoff for free/poll models
    if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
      const max = isPoll || isFree ? Math.min(maxRetries, 1) : maxRetries;
      if (retries < max) {
        const delay = (isPoll || isFree) ? 2000 * (retries + 1) : 500 * (retries + 1);
        if (config.requestLog) log(`[${provider}] retry ${retries + 1}/${max} in ${delay}ms on upstream ${resp.status}`);
        await new Promise(r => setTimeout(r, delay));
        return zenRequest(endpoint, body, { ...opts, retries: retries + 1 });
      }
    }

    throw new APIError(mappedStatus, txt, upstreamMsg);
  }

  // Mark key as validated on success
  if (key) {
    markKeyValid(key);
    reportKeySuccess(key);
  }

  return resp;
}

// ── Model-specific request defaults ──
const MODEL_REQUEST_DEFAULTS = [
  // DeepSeek models with thinking mode — default to enabled with budget
  { pattern: /deepseek|deep-seek/i, overrides: { chat_template_kwargs: { thinking: true } }, minMaxTokens: 1024, toolStream: true },
  // QwOpus — thinking disabled by default for faster response
  { pattern: /qwopus/i, id: "disable_qwopus_thinking", overrides: { chat_template_kwargs: { enable_thinking: false } }, minMaxTokens: 1024, toolStream: true },
];

function _supportsToolStream(modelId) {
  for (const def of MODEL_REQUEST_DEFAULTS) {
    if (def.pattern.test(modelId) && def.toolStream) return true;
  }
  return false;
}

function applyModelDefaults(modelId, body) {
  for (const def of MODEL_REQUEST_DEFAULTS) {
    if (def.pattern.test(modelId)) {
      for (const [key, value] of Object.entries(def.overrides)) {
        if (body[key] === undefined) body[key] = value;
      }
      if (def.minMaxTokens && (body.max_tokens == null || body.max_tokens < def.minMaxTokens)) {
        body.max_tokens = def.minMaxTokens;
      }
    }
  }
}

// ── Model metadata inference (fallback when models.dev unreachable) ──
function inferFamily(modelId) {
  const clean = (modelId || "").replace(/:.*/, "").trim();
  const patterns = [
    [/\bqwen/i, "Qwen"],
    [/\bdeepseek/i, "DeepSeek"],
    [/\bllama/i, "Llama"],
    [/\bmistral/i, "Mistral"],
    [/\bmixtral/i, "Mixtral"],
    [/\bclaude/i, "Claude"],
    [/\bgpt/i, "GPT"],
    [/\bgemini/i, "Gemini"],
    [/\bgemma/i, "Gemma"],
    [/\bcodestral/i, "Codestral"],
    [/\bphi/i, "Phi"],
    [/\bcommand/i, "Command"],
    [/\byi/i, "Yi"],
    [/\bnemotron/i, "Nemotron"],
    [/\bminimax/i, "MiniMax"],
    [/\btrinity/i, "Trinity"],
    [/\bkimi/i, "Kimi"],
    [/\bpoll\//i, "Pollinations"],
    [/\bglm/i, "GLM"],
    [/\bgrok/i, "Grok"],
    [/\bmimo/i, "MiMo"],
    [/\bring/i, "Ring"],
  ];
  for (const [re, family] of patterns) {
    if (re.test(clean)) return family;
  }
  return clean;
}

function inferParameterSize(modelId) {
  const clean = (modelId || "").replace(/:.*/, "").trim();
  const match = clean.match(/(\d+(?:\.\d+)?)\s*([bBmMkK])/);
  if (match) {
    const unit = match[2].toUpperCase();
    if (unit === "B") return `${match[1]}B`;
    if (unit === "M") return `${match[1]}M`;
    if (unit === "K") return `${match[1]}K`;
  }
  return "";
}

function inferQuantization(modelId) {
  const clean = (modelId || "").replace(/:.*/, "").trim();
  const match = clean.match(/(Q\d+[_.]\w+|F\d+|BF\d+|INT\d+|IQ\d+[\w_]*)/i);
  return match ? match[0] : "F16";
}

function inferCapabilities(modelId) {
  if (config.forceAllCapabilities) {
    return ["chat", "completion", "vision", "tools", "agent"];
  }
  const lower = modelId.toLowerCase();
  if (lower.includes("embed") || lower.includes("embedding")) return ["embedding"];
  const caps = ["chat", "completion", "tools"];
  if (lower.includes("vision") || lower.includes("image") || lower.includes("vl")) caps.push("vision");
  return caps;
}

export function resolveModelMetadata(modelId) {
  const clean = (modelId || "").replace(/:.*/, "").trim();
  const override = config.modelMetadataOverrides[clean] || config.modelMetadataOverrides[modelId] || {};
  const allModels = { ...((_mdCache && _mdCache["opencode-go"]?.models) || {}), ...((_mdCache && _mdCache["opencode"]?.models) || {}) };
  const mdModel = allModels[clean] || allModels[modelId];
  const freeDef = FREE_TIER_MODELS.find(m => m.id.toLowerCase() === clean.toLowerCase());

  const contextLength = override.context_length
    || (config.forceContextLength || 0)
    || mdModel?.limit?.context
    || freeDef?.context
    || config.defaultContextLength;

  const capabilities = override.capabilities
    || inferCapabilities(clean);

  const family = override.family
    || mdModel?.name
    || inferFamily(clean);

  const parameterSize = override.parameter_size
    || fmtParamSize(mdModel?.parameter_size || mdModel?.parameter_count || inferParameterSize(clean))
    || "";

  const quantizationLevel = override.quantization_level
    || inferQuantization(clean);

  const size = override.size ?? 0;
  const sizeVram = override.size_vram ?? 0;

  return {
    context_length: contextLength,
    capabilities,
    family,
    parameter_size: parameterSize,
    quantization_level: quantizationLevel,
    size,
    size_vram: sizeVram,
  };
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
    body.tools = compressToolDefinitions(req.tools);
  }

  if (req.options?.temperature != null) body.temperature = req.options.temperature;
  else if (config.defaultTemperature != null) body.temperature = config.defaultTemperature;
  if (req.options?.top_p != null) body.top_p = req.options.top_p;
  if (req.options?.seed != null) body.seed = req.options.seed;
  if (req.options?.num_predict != null) body.max_tokens = req.options.num_predict;
  if (req.options?.stop != null) body.stop = req.options.stop;
  if (req.chat_template_kwargs != null) body.chat_template_kwargs = req.chat_template_kwargs;
  if (req.thinking_token_budget != null) body.thinking_token_budget = req.thinking_token_budget;
  if (req.format === 'json') body.response_format = { type: 'json_object' };

  applyModelDefaults(info.id, body);

  // Auto-enable tool_stream for compatible models (copilot-proxy pattern)
  if (_supportsToolStream(info.id) && body.tools?.length && body.stream !== false) {
    body.tool_stream = true;
  }

  // Per-model request timeout (from antigravity-copilot enrichment)
  let timeoutMs = 0;
  let ac = null;
  if (!req._noTimeout) {
    timeoutMs = ModelConcurrencyManager.getInstance().getTimeoutMs(info.id);
    if (timeoutMs > 0) {
      ac = new AbortController();
      setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
    }
  }

  try {
    const resp = await zenRequest("/chat/completions", body, { signal: ac?.signal, clientTag: req.clientTag });

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
        usage: data.usage,
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
          const delta = choice?.delta;
          if (!delta) continue;
          const msg = { role: "assistant" };
          let hasMsg = false;

          if (delta.content != null) {
            msg.content = delta.content;
            hasMsg = true;
          }
          if (delta.tool_calls?.length) {
            msg.tool_calls = delta.tool_calls;
            hasMsg = true;
          }
          if (delta.reasoning_content) {
            msg.reasoning_content = delta.reasoning_content;
            hasMsg = true;
          }
          if (delta.reasoning) {
            msg.reasoning = delta.reasoning;
            hasMsg = true;
          }

          if (hasMsg) {
            yield { model: req.model, created_at: created, message: msg, done: false };
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e instanceof APIError) throw e; // propagate HTTP errors to server.js
    error(`[stream] ${e.message}`);
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

export { config, SEP_PAID, SEP_FREE, SEP_FREE_P, SEP_M365 };
