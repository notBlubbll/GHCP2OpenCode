// Session keepalive — periodically ping active upstream sessions
// to prevent KV cache eviction during idle (inspired by TaskSync session warming).
//
// When VS/VS Code does iterative development on the same code area, most context
// (system prompt, loaded files, tool results) is identical across turns. By keeping
// the upstream LLM provider's KV cache warm, subsequent turns pay 10x cheaper
// cache-read pricing instead of full input token pricing.
//
// Design:
//   - After each real request completes, save the compressed message list
//   - After KEEPALIVE_INTERVAL_MS of inactivity, send a minimal ping (max_tokens:1)
//     to the upstream API with the same conversation prefix
//   - After KEEPALIVE_IDLE_TIMEOUT_MS of total inactivity, stop pinging and clean up
//   - After KEEPALIVE_MAX_LIFETIME_MS from session creation, stop unconditionally
//     (upstream KV caches don't survive beyond ~24h — pinging a dead cache wastes resources)
//   - Incoming real requests reset the idle timer

import { config, chatCompletion, isFreeTierModel, isPollModel, isM365Model } from "./opencode-client.js";
import { log } from "./logger.js";

const KEEPALIVE_ENABLED = (Bun.env.SESSION_KEEPALIVE_ENABLED || "true") !== "false";
const KEEPALIVE_INTERVAL_MS = Math.max(30000, parseInt(Bun.env.SESSION_KEEPALIVE_INTERVAL_MS || "120000", 10)); // 2 min, min 30s
const KEEPALIVE_IDLE_TIMEOUT_MS = Math.max(KEEPALIVE_INTERVAL_MS * 2, parseInt(Bun.env.SESSION_KEEPALIVE_IDLE_TIMEOUT_MS || "600000", 10)); // 10 min
const KEEPALIVE_MAX_LIFETIME_MS = Math.max(3600000, parseInt(Bun.env.SESSION_KEEPALIVE_MAX_LIFETIME_MS || "86400000", 10)); // 24h, min 1h

const _sessions = new Map(); // sessionId → { model, messages, clientTag, provider, lastActivity, createdAt, timer, pingCount }

let _totalPings = 0;

function getProvider(model) {
  if (isM365Model(model)) return "m365";
  if (isPollModel(model)) return "poll";
  if (isFreeTierModel(model)) return "zen";
  return "go";
}

function scheduleKeepalive(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return;

  if (entry.timer) clearTimeout(entry.timer);

  entry.timer = setTimeout(() => doKeepalive(sessionId), KEEPALIVE_INTERVAL_MS);
  entry.timer.unref?.(); // Don't keep Node.js process alive for keepalive timers
}

async function doKeepalive(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return;

  const idleMs = Date.now() - entry.lastActivity;
  if (idleMs >= KEEPALIVE_IDLE_TIMEOUT_MS) {
    log(`\x1b[90m[keepalive] session ${sessionId} idle ${Math.round(idleMs / 1000)}s — stopping (${entry.pingCount || 0} pings)\x1b[0m`);
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
    return;
  }

  // 24h lifetime cycle — upstream KV caches expire ~24h, so restart the clock
  // to establish a fresh cache entry rather than pinging a dead one
  const ageMs = Date.now() - (entry.createdAt || Date.now());
  if (ageMs >= KEEPALIVE_MAX_LIFETIME_MS) {
    log(`\x1b[90m[keepalive] session ${sessionId} lifetime ${Math.round(ageMs / 3600000)}h exceeded — cycling upstream cache\x1b[0m`);
    entry.createdAt = Date.now();
    entry.pingCount = 0;
    // Fall through — continue with ping to establish new upstream KV cache
  }

  try {
    // Minimal upstream ping: same conversation prefix, max_tokens:1, no stream, no tools
    // The upstream LLM's KV cache stays warm because the prefix matches the real conversation
    const gen = chatCompletion({
      model: entry.model,
      messages: entry.messages,
      stream: false,
      tools: undefined,
      options: { num_predict: 1 },
      _noTimeout: true,
    });

    // Consume the async generator (single yield for stream:false)
    for await (const chunk of gen) {
      if (chunk.done) {
        entry.pingCount = (entry.pingCount || 0) + 1;
        _totalPings++;
        log(`\x1b[90m[keepalive] session ${sessionId} ping #${entry.pingCount} OK (${entry.provider}/${entry.model}, idle ${Math.round(idleMs / 1000)}s)\x1b[0m`);
      }
    }
  } catch (e) {
    // Keepalive failure is non-fatal — clean up stale session
    log(`\x1b[90m[keepalive] session ${sessionId} ping failed: ${e.message} — cleaning up\x1b[0m`);
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
    return;
  }

  // Schedule next keepalive (only if session still tracked)
  if (_sessions.has(sessionId)) {
    scheduleKeepalive(sessionId);
  }
}

export function trackSession(sessionId, model, messages, clientTag) {
  if (!KEEPALIVE_ENABLED) return;
  if (!sessionId || !model) return;
  if (!messages?.length) return;

  // Don't keepalive M365 sessions (WebSocket-based, not HTTP prefix-cacheable)
  if (isM365Model(model)) return;

  const provider = getProvider(model);
  const existing = _sessions.get(sessionId);

  _sessions.set(sessionId, {
    model,
    messages: messages.slice(), // shallow copy of compressed message array
    clientTag,
    provider,
    lastActivity: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
    timer: existing?.timer || null,
    pingCount: existing?.pingCount || 0,
  });

  scheduleKeepalive(sessionId);
}

export function touchSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
    scheduleKeepalive(sessionId);
  }
}

export function stopSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
  }
}

export function shutdown() {
  let count = 0;
  for (const [sessionId, entry] of _sessions) {
    if (entry.timer) clearTimeout(entry.timer);
    count++;
  }
  _sessions.clear();
  if (count > 0) {
    log(`\x1b[90m[keepalive] shutdown — cleaned up ${count} session(s), ${_totalPings} total pings\x1b[0m`);
  }
}

export function stats() {
  return {
    sessions: _sessions.size,
    enabled: KEEPALIVE_ENABLED,
    intervalMs: KEEPALIVE_INTERVAL_MS,
    idleTimeoutMs: KEEPALIVE_IDLE_TIMEOUT_MS,
    maxLifetimeMs: KEEPALIVE_MAX_LIFETIME_MS,
    totalPings: _totalPings,
  };
}

export { KEEPALIVE_ENABLED, KEEPALIVE_INTERVAL_MS, KEEPALIVE_IDLE_TIMEOUT_MS, KEEPALIVE_MAX_LIFETIME_MS };
