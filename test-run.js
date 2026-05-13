process.on("uncaughtException", e => { process.stderr.write(`\n[test] uncaught: ${e.stack || e.message}\n`); process.exit(1); });
process.on("unhandledRejection", e => { process.stderr.write(`\n[test] unhandled: ${e?.stack || e?.message}\n`); });
process.on("exit", code => { process.stderr.write(`\n[test] exit code=${code}\n`); });
import("./src/server.js").then(() => process.stderr.write("[test] import done\n")).catch(e => process.stderr.write(`[test] import fail: ${e.stack || e.message}\n`));
