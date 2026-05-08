// ── Token Optimization ──
// Enriched from https://github.com/barrersoftware/copilot-plugin-mcp-server (67% token reduction)
// Enriched from https://github.com/diegosouzapw/OmniRoute (RTK+Caveman stacked compression up to ~95%)
// Enriched from https://github.com/JuliusBrussee/caveman (30+ regex rules for filler removal)
//
// Compression levels (inspired by OmniRoute):
//   Off       (0%)    — No compression
//   Lite      (~15%)  — Whitespace collapse, dedup system prompts
//   Caveman   (~30%)  — 30+ regex rules: filler removal, context condensation, structural compression
//   Aggressive(~50%)  — All Caveman + progressive message aging + tool result summarization
//   Ultra     (~75%)  — All Aggressive + heuristic token pruning + stopword removal
//   RTK       (60-90%)— Command-aware filters for shell/test/build/git output
//   Stacked   (78-95%)— RTK first, then Caveman — best for mixed prompts with tool logs + prose
//
// Also compresses tool descriptions, schemas, identity prompts, and tool instructions.
//
// Compression strategies:
//   1. Strip verbose prefixes ("This tool allows you to", "Use this function to")
//   2. Remove clause-level redundancy ("the following", "is not case sensitive")
//   3. Truncate to first sentence (max ~120 chars)
//   4. Strip property-level descriptions from tool schemas
//   5. Caveman: 30+ regex rules for filler removal, structural compression
//   6. RTK: command-aware output compression (shell, git, grep, test, build)
//   7. Stacked: RTK → Caveman chain for maximum savings

// ── Compression level enum ──
export const CompressionLevel = Object.freeze({
  OFF: "off",
  LITE: "lite",
  CAVEMAN: "caveman",
  STANDARD: "standard", // alias for caveman
  AGGRESSIVE: "aggressive",
  ULTRA: "ultra",
  RTK: "rtk",
  STACKED: "stacked",
});

// ── Common term substitutions ──
function _substitute(d) {
  return d
    .replace(/GitHub\s*Copilot\s*Chat/gi, "Copilot Chat")
    .replace(/directory/gi, "dir")
    .replace(/directories/gi, "dirs")
    .replace(/parameter\s+/gi, "param ")
    .replace(/parameters\s*/gi, "params ")
    .replace(/\s{2,}/g, " ");
}

// ═══════════════════════════════════════════════════
// Tool description compression (from copilot-plugin-mcp-server)
// ═══════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════
// Identity & instruction compression
// ═══════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════
// Lite compression (~15% savings)
// Whitespace collapse, dedup system prompts
// ═══════════════════════════════════════════════════

function _compressLite(text) {
  if (!text) return text;
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

// ═══════════════════════════════════════════════════
// Caveman compression (~30% savings)
// 30+ regex rules: filler removal, context condensation,
// structural compression, multi-turn dedup
// Inspired by https://github.com/JuliusBrussee/caveman
// ═══════════════════════════════════════════════════

const CAVEMAN_RULES = [
  // ── Filler / politeness removal ──
  { re: /^(ok(ay)?|sure|alright|got\s*it|understood|noted|sounds?\s*good|makes?\s*sense)[,.:;!]*\s*/gim, rep: "" },
  { re: /\b(I\s*hope\s+this\s+helps?|I\s*hope\s+this\s+is\s+helpful|hope\s+that\s+helps?)[.!]*\s*/gi, rep: "" },
  { re: /\b(please\s+let\s+me\s+know\s+if\s+(you\s+have\s+(any|further)\s+)?questions?|let\s+me\s+know\s+if\s+you\s+need\s+(anything|help|further|more)\s+else)[.!]*\s*/gi, rep: "" },
  { re: /\b(feel\s+free\s+to\s+(ask|reach\s+out)|don\x27t\s+hesitate\s+to\s+(ask|reach\s+out))[.!]*\s*/gi, rep: "" },
  { re: /\b(I(\x27m|\s+am)\s+(happy|glad)\s+to\s+help|happy\s+to\s+(assist|help|clarify))[.!]*\s*/gi, rep: "" },
  { re: /\b(you(\x27re|\s+are)\s+welcome|no\s+problem|my\s+pleasure)[.!]*\s*/gi, rep: "" },
  { re: /\bthanks?(\s*you)?(\s+so\s+much)?(\s+for\s+(asking|your\s+question|pointing|bringing))?[.!]*\s*/gi, rep: "" },
  { re: /\b(that(\x27s|\s+is)\s+a\s+(good|great|excellent|interesting|valid)\s+question)[,.\s]*/gi, rep: "" },
  { re: /\b(I\s+apologize|I(\x27m|\s+am)\s+sorry|sorry\s+(about|for)\s+that|my\s+(apologies|bad|mistake))[.!]*\s*/gi, rep: "" },

  // ── Redundant preamble / context reminders ──
  { re: /^(here(\x27s|\s+is)\s+(the\s+)?(an\s+)?(overview|summary|breakdown|explanation|update)\s*(of\s+the\s+)?(code|changes?|file|situation|problem)?[,:]*\s*)/gim, rep: "" },
  { re: /^(based\s+on\s+(the\s+|our\s+)?(above|previous|earlier|current|existing)\s+(discussion|conversation|context|analysis|code|information)[,:]*\s*)/gim, rep: "" },
  { re: /^(as\s+(I\s+)?(mentioned|discussed|explained|noted|stated)\s+(above|before|earlier|previously)[,:]*\s*)/gim, rep: "" },
  { re: /^(to\s+(answer|address|solve|respond\s+to)\s+your\s+question[,:]*\s*)/gim, rep: "" },
  { re: /^(looking\s+at\s+(the|your)\s+(code|file|project|setup|configuration)[,:]*\s*)/gim, rep: "" },
  { re: /^(from\s+the\s+(provided|given|attached)\s+(code|snippet|file|information|context)[,:]*\s*)/gim, rep: "" },

  // ── Verbose connector phrases ──
  { re: /\b(in\s+addition\s+to\s+(that|this)|furthermore|moreover|additionally|also\s+note\s+that|it(\x27s|\s+is)\s+worth\s+(noting|mentioning)|keep\s+in\s+mind\s+that)[,.\s]*/gi, rep: "" },
  { re: /\b(on\s+the\s+(other|flip)\s+side|conversely|alternatively|that\s+said|having\s+said\s+that)[,.\s]*/gi, rep: "" },
  { re: /\b(in\s+(summary|conclusion|short|essence|other\s+words)|to\s+(summarize|wrap\s+up|put\s+it\s+(all|simply)|be\s+(clear|specific|precise)))[,.\s]*/gi, rep: "" },
  { re: /\b(as\s+(a|an)\s+(result|consequence|side\s+note|example|reference|reminder|general\s+rule))[,.\s]*/gi, rep: "" },
  { re: /\b(for\s+(example|instance|reference|clarity|context|comparison|more\s+information|further\s+details))[,.\s]*/gi, rep: "" },

  // ── Code explanation condensation ──
  { re: /\b(this\s+(code|function|method|class|block|snippet|line|approach|solution|implementation|pattern)\s*(is|will|would|does|should|can|allows?)\s*)/gi, rep: "" },
  { re: /\b(the\s+(reason|issue|problem|bug|error|challenge)\s+(is|was|appears?\s+to\s+be|seems?\s+to\s+be|might\s+be)\s+that)/gi, rep: "" },
  { re: /\b((what|which)\s+(this|it)\s+does\s+is\s*)/gi, rep: "" },
  { re: /\b(this\s+will\s+(result\s+in|lead\s+to|cause|trigger|produce|generate|create|return)\s*)/gi, rep: "" },
  { re: /\b(you\s+(can|could|should|might\s+want\s+to|may\s+wish\s+to)\s+(use|try|consider|apply|implement|call|run))\s*/gi, rep: "use " },
  { re: /\b(what\s+you\s+need\s+(to\s+do|is)\s+is\s*)/gi, rep: "" },
  { re: /\b(you\x27ll|you\s+will)\s+need\s+to\s+/gi, rep: "" },
  { re: /\b(I\s+(would|will|\x27ll|can|could)\s+(recommend|suggest|advise|propose))\s*(you\s+)?/gi, rep: "" },

  // ── Structural compression ──
  { re: /^(###+\s+)/gm, rep: "## " },
  { re: /^(\*\s*){3,}$/gm, rep: "---" },
  { re: /^(\-{3,}|_{3,})$/gm, rep: "---" },

  // ── Multi-turn dedup: remove repeated lines ──
  // Handled separately in _dedupRepeatedLines()

  // ── Numbered list compression ──
  { re: /^(\d+)[.)]\s+/gm, rep: "$1) " },

  // ── Trailing cleanup ──
  { re: /[ \t]+$/gm, rep: "" },
  { re: /\n{3,}/g, rep: "\n\n" },
];

function _applyCaveman(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const rule of CAVEMAN_RULES) {
    result = result.replace(rule.re, rule.rep);
  }
  // Dedup repeated consecutive lines
  result = _dedupRepeatedLines(result);
  // Collapse multiple spaces
  result = result.replace(/\s{2,}/g, " ").replace(/^\s+|\s+$/gm, "").trim();
  return result;
}

function _dedupRepeatedLines(text) {
  const lines = text.split("\n");
  const deduped = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && i > 0 && trimmed === (lines[i - 1] || "").trim()) continue;
    // Also dedup headers that repeat
    if (trimmed.startsWith("## ") && i > 0) {
      const prevTrimmed = (lines[i - 1] || "").trim();
      if (prevTrimmed.startsWith("## ") && trimmed === prevTrimmed) continue;
    }
    deduped.push(lines[i]);
  }
  return deduped.join("\n");
}

// ═══════════════════════════════════════════════════
// RTK compression (60-90% savings)
// Command-aware filters for shell/test/build/git output
// Inspired by https://github.com/rtk-ai/rtk (RTK - Rust Token Killer)
// ═══════════════════════════════════════════════════

// Detect if text looks like command output
function _isCommandOutput(text) {
  if (!text) return false;
  const patterns = [
    /^(diff\s|index\s|@@\s|--+\s)/m, // git diff / patches
    /^(commit\s[\da-f]{7,}|Author:|Date:|Merge:)/m, // git log
    /^(On\sbranch\s|Your\sbranch\s|nothing\sto\scommit|Changes\s(not\sstaged|to\sbe\scommitted))/m, // git status
    /^(test\s|tests\s|failures|FAILED|PASSED)\s/m, // test output
    /^(error|warning|info|debug|trace)(\[|:|\s)/im, // log output
    /^(npm|yarn|pip|bun|node|cargo|go)\s/im, // package manager / CLI output
    /^(\s*\d+\s*(test|spec|suite)|Ran\s\d+|Finished\s)/m, // test runner output
    /^(Compiling|Building|Running|Generating|Transpiling|Bundling|Downloading|Installing)/m, // build output
    /^(?:\d+\s+)?(?:error|warn|warning|info|debug)(?:\s+\d+)?[:)]/im, // structured log
    /^(?:total\s+\d+|passed|failed|skipped|pending)/im, // test summary
    /^(?:Real\s+|User\s+|Sys\s+|CPU\s+)/m, // perf output
    /^(?:root|src|tests?|lib|node_modules)\//m, // file path lines
  ];
  return patterns.some(p => p.test(text));
}

// RTK compression rules for command output
const RTK_RULES = [
  // Git diff: compress @@ headers
  { re: /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/gm, rep: "@@ -$1 +$2 @@" },
  // Git diff: strip context lines that repeat
  { re: /^( {4}|\t)(.*)$/gm, rep: (m, ws, code) => (code || "").trim().length < 3 ? "" : m },
  // npm/yarn: strip timing and progress
  { re: /^.*?(?:added|removed|changed|audited)\s+\d+\s+packages?\s+in\s+\d+/gm, rep: (m) => m.replace(/in\s+\d+\.?\d*\s*[sm]/g, "").trim() },
  // Verbose log timestamps
  { re: /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\]\s*/gm, rep: "" },
  { re: /^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/gm, rep: "" },
  // Strip ANSI color codes
  { re: /\x1b\[[0-9;]*m/g, rep: "" },
  // Compression of repeated build output patterns
  { re: /^(?:\s+)(?:Compiling|Checking|Running|Scanning)/gm, rep: "  ..." },
  // Test output: compress dots
  { re: /\.{20,}/g, rep: (m) => `...(${m.length} tests)` },
  // Path abbreviation for deeply nested
  { re: /((?:\/[\w.-]+){4,})\//g, rep: (m) => "../" + m.split("/").filter(Boolean).slice(-2).join("/") + "/" },
  // Stack traces: keep only meaningful lines
  { re: /^\s+at\s+.+?\(.+?:\d+:\d+\)\s*$/gm, rep: "" },
  { re: /^\s+at\s+.+?:\d+:\d+\s*$/gm, rep: "" },
  // Strip blank lines in code blocks
  { re: /```[\s\S]*?```/g, rep: (m) => m.replace(/\n{3,}/g, "\n\n") },
];

function _applyRTK(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const rule of RTK_RULES) {
    result = result.replace(rule.re, rule.rep);
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

// ═══════════════════════════════════════════════════
// Aggressive compression (~50% savings)
// All Caveman + progressive message aging + tool result summarization
// ═══════════════════════════════════════════════════

function _summarizeToolResult(text, toolName) {
  if (!text) return text;
  // For grep results: "file:line:content"
  if (/^([\w./\\-]+):(\d+):/.test(text) && text.length > 500) {
    const lines = text.split("\n").filter(Boolean);
    const fileMatch = lines[0].match(/^([\w./\\-]+):(\d+):/);
    if (fileMatch) {
      const file = fileMatch[1].split("/").pop() || fileMatch[1];
      return `[${file}+${lines.length} matches in ${lines[0].split(":")[0]}]`;
    }
  }
  // For file reads: show first ~500 chars
  if (toolName === "read" && text.length > 500) {
    const head = text.slice(0, 300).replace(/\n/g, " ").trim();
    return `[read snippet: ${head}... (${text.length} chars total)]`;
  }
  // For ls/dir: compress long listings
  if ((toolName === "ls" || toolName === "dir" || toolName === "list_files") && text.length > 300) {
    const count = (text.match(/\n/g) || []).length + 1;
    return `[${count} files/dirs]`;
  }
  // For git diff: summarise
  if (toolName === "git diff" && text.length > 1000) {
    const fileMatches = text.match(/^diff --git\s+a\/(.+?)\s+b\//gm);
    const files = fileMatches ? fileMatches.map(m => m.match(/a\/(.+?)\s/)?.[1] || "").filter(Boolean) : [];
    return files.length ? `[diff: ${files.join(" ")}]` : text.slice(0, 200) + "...";
  }
  return text;
}

function _progressiveAging(messages) {
  if (!messages?.length) return messages;
  const total = messages.length;
  return messages.map((m, i) => {
    if (total <= 6) return m; // Don't age short conversations
    const age = total - 1 - i; // 0 = newest, high = oldest
    if (age <= 2) return m;
    if (age <= 5) {
      // Medium age: truncate content
      const content = typeof m.content === "string" ? m.content : "";
      if (content.length > 200) {
        return { ...m, content: content.slice(0, 200) + "..." };
      }
      return m;
    }
    // Old messages: heavily summarize
    const content = typeof m.content === "string" ? m.content : "";
    if (content.length > 80) {
      return { ...m, content: content.slice(0, 80) + "..." };
    }
    return m;
  });
}

// ═══════════════════════════════════════════════════
// Ultra compression (~75% savings)
// All Aggressive + heuristic token pruning + stopword removal
// ═══════════════════════════════════════════════════

const ULTRA_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "of", "in", "to",
  "for", "with", "on", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "under",
  "again", "further", "then", "once", "here", "there", "when", "where",
  "why", "how", "all", "both", "each", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "about", "now", "also", "still",
]);

function _heuristicPrune(text) {
  if (!text || text.length < 200) return text;
  const lines = text.split("\n");
  const scored = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return { line, score: -1 }; // keep blank lines
    // Score: longer lines, lines with code/numbers, lines with file paths score higher
    let score = trimmed.length;
    if (/[{}();<>=]/.test(trimmed)) score += 20;
    if (/\d/.test(trimmed)) score += 10;
    if (/[/\\]/.test(trimmed)) score += 5;
    if (/^[A-Z][a-z]+\s/.test(trimmed)) score += 3; // likely English sentence
    return { line, score };
  });
  // Sort by score descending, keep top 70%
  const threshold = Math.floor(scored.length * 0.7);
  const keep = new Set();
  scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, threshold)
    .forEach((_, i) => keep.add(scored.indexOf(_)));
  return lines.filter((_, i) => scored[i].score < 0 || keep.has(i)).join("\n");
}

function _stripStopwords(text) {
  const words = text.split(/(\s+)/);
  let result = "";
  let skipCount = 0;
  for (const w of words) {
    if (ULTRA_STOPWORDS.has(w.toLowerCase()) && skipCount < 30) {
      skipCount++;
      continue;
    }
    result += w;
  }
  return result;
}

// ═══════════════════════════════════════════════════
// Main compression pipeline
// ═══════════════════════════════════════════════════

/**
 * Apply token optimization to message content based on compression level.
 * @param {string} content - The message content to compress
 * @param {'off'|'lite'|'caveman'|'standard'|'aggressive'|'ultra'|'rtk'|'stacked'} level - Compression level
 * @param {string} [toolName] - Optional tool name for tool-result compression
 * @returns {string} Compressed content
 */
export function compressContent(content, level = "stacked", toolName = "") {
  if (!content || typeof content !== "string") return content || "";
  if (level === "off") return content;

  // Preserve code blocks from compression
  const codeBlocks = [];
  const preserved = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Also preserve inline code
  const inlineCodes = [];
  const preserved2 = preserved.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00INLCODE${inlineCodes.length - 1}\x00`;
  });

  let result = preserved2;

  // Lite compression: always applied for any level above off
  if (level !== "off") {
    result = _compressLite(result);
  }

  // Caveman / Standard
  if (level === "caveman" || level === "standard" || level === "aggressive" || level === "ultra" || level === "stacked") {
    result = _applyCaveman(result);
  }

  // Aggressive
  if (level === "aggressive" || level === "ultra") {
    if (toolName) {
      result = _summarizeToolResult(result, toolName);
    }
  }

  // Ultra
  if (level === "ultra") {
    result = _heuristicPrune(result);
    result = _stripStopwords(result);
  }

  // RTK
  if (level === "rtk" || level === "stacked") {
    if (_isCommandOutput(result)) {
      result = _applyRTK(result);
    }
  }

  // Stacked: RTK first, then Caveman
  if (level === "stacked") {
    result = _applyCaveman(result);
  }

  // Restore code blocks
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)] || "");
  result = result.replace(/\x00INLCODE(\d+)\x00/g, (_, i) => inlineCodes[parseInt(i)] || "");

  return result;
}

/**
 * Compress an entire messages array.
 * @param {Array} messages - Array of {role, content, ...} objects
 * @param {'off'|'lite'|'caveman'|'standard'|'aggressive'|'ultra'|'rtk'|'stacked'} level
 * @param {boolean} progressiveAging - Whether to apply progressive message aging
 * @returns {Array} Compressed messages
 */
export function compressMessages(messages, level = "stacked", progressiveAging = true) {
  if (!messages?.length || level === "off") return messages;

  let msgs = messages;

  // Progressive aging: reduce older messages more
  if (progressiveAging && (level === "aggressive" || level === "ultra")) {
    msgs = _progressiveAging(msgs);
  }

  return msgs.map(m => {
    if (!m.content) return m;
    const toolRole = m.role === "tool";
    // Infer tool name from context
    let toolName = "";
    if (toolRole && m.tool_call_id) {
      // Look back for the assistant message with matching tool_calls
      const idx = msgs.indexOf(m);
      if (idx > 0) {
        const prev = msgs[idx - 1];
        if (prev?.tool_calls?.length) {
          for (const tc of prev.tool_calls) {
            if (tc.id === m.tool_call_id || tc.function?.name) {
              toolName = tc.function?.name || "";
              break;
            }
          }
        }
      }
    }

    let compressed;
    if (toolRole && level !== "lite" && level !== "off") {
      // Use RTK (or stacked) for tool outputs which are often command results
      const toolLevel = (level === "rtk" || level === "stacked") ? level : "caveman";
      compressed = compressContent(
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        toolLevel,
        toolName
      );
    } else {
      compressed = compressContent(
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        level
      );
    }

    return { ...m, content: compressed };
  });
}

/**
 * Apply the best compression (Stacked: RTK → Caveman, ~89% average savings on eligible payloads).
 * Shortcut for compressContent(content, "stacked").
 */
export function compressBest(content, toolName) {
  return compressContent(content, "stacked", toolName);
}

/**
 * Get estimated token savings percentage for a given compression level.
 */
export function estimatedSavings(level) {
  switch (level) {
    case "off": return 0;
    case "lite": return 15;
    case "caveman":
    case "standard": return 30;
    case "aggressive": return 50;
    case "ultra": return 75;
    case "rtk": return 80;
    case "stacked": return 89;
    default: return 0;
  }
}
