const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });

function log(msg) {
  process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`\x1b[90m${ts()}\x1b[0m \x1b[33m${msg}\x1b[0m\n`);
}

function error(msg) {
  process.stderr.write(`\x1b[90m${ts()}\x1b[0m \x1b[31m${msg}\x1b[0m\n`);
}

function reqLog({ tag, provider, model, preview, elapsed }) {
  const tsPart = `\x1b[90m${ts()}\x1b[0m`;
  const tagPart = tag ? `[${tag}]>` : "";
  const provModel = `[${provider}/${model || "?"}]`;
  const trail = preview ? `—${JSON.stringify(preview)}` : "";
  process.stdout.write(`${tsPart} ${tagPart}${provModel}${trail}— … `);
  if (elapsed != null) {
    process.stdout.write(`\x1b[32m->\x1b[0m [${elapsed}ms]\n`);
    return;
  }
  return (elapsed) => {
    process.stdout.write(`\x1b[32m->\x1b[0m [${elapsed}ms]\n`);
  };
}

export { ts, log, warn, error, reqLog };
