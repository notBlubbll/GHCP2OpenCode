// ── Token Optimization ──
// Enriched from https://github.com/barrersoftware/copilot-plugin-mcp-server (67% token reduction)
//
// Compresses tool descriptions, schemas, identity prompts, and tool instructions
// to reduce token consumption per request. Targets include:
//   - Identity injection (system prompt — every request)
//   - Tool definitions forwarded to upstream API
//   - Tool usage instruction prompts
//   - Code completion system prompts
//
// Compression strategies:
//   1. Strip verbose prefixes ("This tool allows you to", "Use this function to")
//   2. Remove clause-level redundancy ("the following", "is not case sensitive")
//   3. Truncate to first sentence (max ~120 chars)
//   4. Strip property-level descriptions from tool schemas

// Common term substitutions
function _substitute(d) {
  return d
    .replace(/GitHub\s*Copilot\s*Chat/gi, "Copilot Chat")
    .replace(/directory/gi, "dir")
    .replace(/directories/gi, "dirs")
    .replace(/parameter\s+/gi, "param ")
    .replace(/parameters\s*/gi, "params ")
    .replace(/\s{2,}/g, " ");
}

export function compressDescription(desc) {
  if (!desc) return "";
  let c = desc
    .replace(/^(This tool|Use this tool|This function|Use this function)\s*(allows you to|enables you to|lets you|helps you|can be used to)?\s*/gi, "")
    .replace(/\s+(allows you to|enables you to|lets you|helps you to)\s+/gi, " ")
    .replace(/the\s+following\s+/gi, "")
    .replace(/\.?\s*You\s+must\s+have\s+.+?\s+access.+?\./gi, "")
    .replace(/\.?\s*The\s+.*?\s+is\s+not\s+case\s+sensitive\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (c.length > 120) {
    const first = c.match(/^[^.!?]+[.!?]/);
    c = first ? first[0] : c.slice(0, 120) + "...";
  }
  c = _substitute(c);

  return c;
}

export function compressToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;

  if (schema.properties) {
    out.properties = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      out.properties[key] = compressToolSchema(prop);
    }
  }
  if (schema.items) out.items = compressToolSchema(schema.items);

  return out;
}

export function compressToolDefinitions(tools) {
  if (!tools?.length) return tools;
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.function.name,
      description: compressDescription(t.function.description),
      parameters: compressToolSchema(t.function.parameters),
    },
  }));
}

export function compactIdentity(model) {
  return `You are GitHub Copilot via GHCP2OC Proxy running ${model}. Always say you are "Copilot (GHCP2OC)" running ${model}.`;
}

export function compactToolInstructions() {
  return "Use tools for the task. Reply with tool calls, not descriptions.";
}

export function compactOllamaToolInstructions(tools) {
  const toolList = tools.map(t =>
    `${t.function.name}: ${t.function.description ? compressDescription(t.function.description) : "(no desc)"}`
  ).join("\n");
  return `Tools:\n${toolList}\nFormat: \`\`\`tool\n{"name":"...","arguments":{...}}\n\`\`\``;
}

export function compactCodeCompletionPrompt() {
  return "Complete code. Return only the completion, no explanations.";
}
