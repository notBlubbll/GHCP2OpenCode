// Test grep_search / search_content / search_file JSON salvage

let passed = 0, failed = 0;

function salvage(raw) {
  const safe = {};
  const qMatch = raw.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  safe.query = qMatch ? qMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
  safe.isRegexp = /"isRegexp"\s*:\s*true/i.test(raw);
  const ipMatch = raw.match(/"includePattern"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  safe.includePattern = ipMatch ? ipMatch[1] : null;
  const mrMatch = raw.match(/"maxResults"\s*:\s*(\d+)/);
  safe.maxResults = mrMatch ? parseInt(mrMatch[1], 10) : null;
  return safe;
}

function test(name, raw, expected) {
  const result = salvage(raw);
  const ok = Object.keys(expected).every(k => {
    if (expected[k] === null && result[k] === null) return true;
    return JSON.stringify(result[k]) === JSON.stringify(expected[k]);
  }) && Object.keys(result).every(k => k in expected);
  if (ok) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}`); console.log(`    raw: ${raw}`); console.log(`    got: ${JSON.stringify(result)}`); console.log(`    exp: ${JSON.stringify(expected)}`); }
}

// ── Valid JSON (wouldn't reach salvage, but tests regex correctness) ──
test('valid - all fields',
  '{"query": "async Task Main", "isRegexp": false, "includePattern": "*.cs", "maxResults": 20}',
  { query: "async Task Main", isRegexp: false, includePattern: "*.cs", maxResults: 20 });

test('valid - isRegexp true',
  '{"query": "IDisposable", "isRegexp": true, "includePattern": "*.cs", "maxResults": 10}',
  { query: "IDisposable", isRegexp: true, includePattern: "*.cs", maxResults: 10 });

// ── Malformed: unquoted includePattern (the original bug) ──
test('bug - unquoted includePattern',
  '{"query": "static async Task", "isRegexp": false, "includePattern": *.cs, "maxResults": 20}',
  { query: "static async Task", isRegexp: false, includePattern: null, maxResults: 20 });

// ── Malformed: unquoted regex metachar in includePattern ──
test('unquoted glob with braces',
  '{"query": "Controller", "isRegexp": false, "includePattern": *.{cs,cshtml}, "maxResults": 50}',
  { query: "Controller", isRegexp: false, includePattern: null, maxResults: 50 });

// ── Malformed: truncated JSON (missing closing brace) ──
test('truncated - no closing brace',
  '{"query": "ConfigureServices", "isRegexp": false, "includePattern": "*.cs", "maxResults": 10',
  { query: "ConfigureServices", isRegexp: false, includePattern: "*.cs", maxResults: 10 });

// ── Malformed: missing includePattern field entirely ──
test('missing includePattern field',
  '{"query": "app.Run", "isRegexp": true, "maxResults": 5}',
  { query: "app.Run", isRegexp: true, includePattern: null, maxResults: 5 });

// ── Malformed: includePattern as null (valid JSON, just testing salvage) ──
test('includePattern null',
  '{"query": "DBContext", "isRegexp": false, "includePattern": null, "maxResults": 10}',
  { query: "DBContext", isRegexp: false, includePattern: null, maxResults: 10 });

// ── Malformed: escaped quotes in query ──
test('escaped quotes in query',
  '{"query": "app.\\"Run", "isRegexp": false, "includePattern": "*.cs", "maxResults": 20}',
  { query: 'app."Run', isRegexp: false, includePattern: "*.cs", maxResults: 20 });

// ── Malformed: maxResults missing ──
test('missing maxResults',
  '{"query": "namespace", "isRegexp": false, "includePattern": "*.cs"}',
  { query: "namespace", isRegexp: false, includePattern: "*.cs", maxResults: null });

// ── Malformed: only query present ──
test('only query present',
  '{"query": "Main"}',
  { query: "Main", isRegexp: false, includePattern: null, maxResults: null });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
