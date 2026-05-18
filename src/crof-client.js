// Cross-runtime compatibility polyfill
if (typeof Bun === 'undefined') {
  globalThis.Bun = { env: process.env };
}

const CROF_BASE_URL = "https://crof.ai/v1";

export function isCrofAvailable() {
  const key = Bun.env.CROF_API_KEY;
  return !!(key && key.trim());
}

export function getCrofApiKey() {
  return Bun.env.CROF_API_KEY || "";
}

let _cachedModels = null;

export async function getCrofModels() {
  if (_cachedModels !== null) return _cachedModels;
  if (!isCrofAvailable()) { _cachedModels = []; return []; }
  try {
    const resp = await fetch(`${CROF_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${getCrofApiKey()}` },
    });
    if (!resp.ok) { _cachedModels = []; return []; }
    const json = await resp.json();
    _cachedModels = (json.data || []).map(m => {
      const prefixed = `crof/${m.id}`;
      return {
        id: prefixed,
        name: m.name || m.id,
        family: prefixed,
        context_length: m.context_length || 131072,
        tools: true,
        vision: true,
        _crof: true,
        _apiModel: m.id,
      };
    });
    return _cachedModels;
  } catch (e) {
    _cachedModels = [];
    return [];
  }
}

export function clearCrofCache() {
  _cachedModels = null;
}
