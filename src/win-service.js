/**
 * Windows Service integration via bun:ffi + sc.exe.
 *
 * CLI usage (pass to compiled exe):
 *   gc2oc.exe --install-service     → register as Windows service (auto-start)
 *   gc2oc.exe --uninstall-service   → stop + remove Windows service
 *   gc2oc.exe --service             → run in service mode (called by SCM, not directly)
 *   gc2oc.exe                       → normal console mode
 *
 * Env vars for install:
 *   GC2OC_SERVICE_NAME    → service key name   (default: gc2oc)
 *   GC2OC_SERVICE_DISPLAY → display name       (default: gc2oc Proxy)
 *   GC2OC_SERVICE_DESC    → description        (default: "Ollama-compatible ...")
 *   GC2OC_SERVICE_START   → start type: auto | demand | disabled  (default: auto)
 *   GC2OC_SERVICE_ARGS    → extra args passed to exe after --service
 */

// --------------- helpers ---------------

let _isBun = false;
try { _isBun = typeof Bun !== 'undefined'; } catch {}

const SERVICE_NAME = process.env.GC2OC_SERVICE_NAME || "gc2oc";
const DISPLAY_NAME = process.env.GC2OC_SERVICE_DISPLAY || "gc2oc Proxy";
const DESCRIPTION  = process.env.GC2OC_SERVICE_DESC  || "Ollama-compatible proxy connecting GitHub Copilot to OpenCode models";
const START_TYPE   = process.env.GC2OC_SERVICE_START || "auto";
const EXTRA_ARGS   = process.env.GC2OC_SERVICE_ARGS  || "";

// SCM constants (winnt.h)
const SERVICE_WIN32_OWN_PROCESS = 0x00000010;
const SERVICE_RUNNING           = 0x00000004;
const SERVICE_STOPPED           = 0x00000001;
const SERVICE_START_PENDING     = 0x00000002;
const SERVICE_STOP_PENDING      = 0x00000003;
const SERVICE_ACCEPT_STOP       = 0x00000001;
const SERVICE_ACCEPT_SHUTDOWN   = 0x00000004;
const SERVICE_CONTROL_STOP      = 0x00000001;
const SERVICE_CONTROL_SHUTDOWN  = 0x00000005;
const SERVICE_CONTROL_INTERROGATE = 0x00000004;
const NO_ERROR = 0;

function _exec(cmd) {
  return new Promise((resolve) => {
    try {
      const { exec } = require("child_process");
      exec(cmd, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout||""), stderr: String(stderr||"") });
      });
    } catch (e) {
      resolve({ err: e, stdout: "", stderr: String(e) });
    }
  });
}

function _quote(s) { return `"${s}"`; }

// --------------- install / uninstall (via sc.exe) ---------------

export async function installService(exePath) {
  const binPath = `${_quote(exePath)} --service ${EXTRA_ARGS}`.trim();

  const createCmd = `sc create ${SERVICE_NAME} binPath= ${binPath} start= ${START_TYPE} DisplayName= ${_quote(DISPLAY_NAME)}`;
  const { err, stdout, stderr } = await _exec(createCmd);
  if (err) {
    process.stderr.write(`[win-svc] sc create failed: ${err.message || stderr}\n`);
    return false;
  }
  process.stdout.write(`[win-svc] Created service "${SERVICE_NAME}"\n`);

  // Set description (separate sc command)
  const descCmd = `sc description ${SERVICE_NAME} ${_quote(DESCRIPTION)}`;
  await _exec(descCmd);

  // Set failure recovery: restart on failure, reset counter after 1 day
  const failCmd = `sc failure ${SERVICE_NAME} reset= 86400 actions= restart/5000/restart/10000/restart/30000`;
  await _exec(failCmd);
  process.stdout.write(`[win-svc] Failure recovery configured: 3 restarts, daily reset\n`);

  process.stdout.write(`[win-svc] Service "${SERVICE_NAME}" ready. Use \`sc start ${SERVICE_NAME}\` to start.\n`);
  return true;
}

export async function uninstallService() {
  process.stdout.write(`[win-svc] Stopping service "${SERVICE_NAME}"...\n`);

  const stopCmd = `sc stop ${SERVICE_NAME}`;
  const { err: stopErr } = await _exec(stopCmd);
  // Ignore stop errors — service may already be stopped
  if (stopErr) {
    process.stderr.write(`[win-svc] sc stop note: ${stopErr.message || "already stopped"}\n`);
  }

  // Small delay for shutdown
  await new Promise(r => setTimeout(r, 2000));

  const delCmd = `sc delete ${SERVICE_NAME}`;
  const { err: delErr, stderr: delStderr } = await _exec(delCmd);
  if (delErr) {
    process.stderr.write(`[win-svc] sc delete failed: ${delStderr || delErr.message}\n`);
    return false;
  }
  process.stdout.write(`[win-svc] Service "${SERVICE_NAME}" removed.\n`);
  return true;
}

// --------------- service command routing ---------------

export async function handleServiceCommand(argv) {
  if (process.platform !== "win32") return { handled: false, exitCode: 0 };

  if (argv.includes("--install-service")) {
    const ok = await installService(process.execPath);
    return { handled: true, exitCode: ok ? 0 : 1 };
  }
  if (argv.includes("--uninstall-service")) {
    const ok = await uninstallService();
    return { handled: true, exitCode: ok ? 0 : 1 };
  }
  return { handled: false, exitCode: 0 };
}

// --------------- service dispatch (bun:ffi) ---------------

// Buffers referenced from FFI callbacks — keep alive to prevent GC
let _keepAlive = [];

function _keep(buf) { _keepAlive.push(buf); return buf; }

function _toWideBuf(str) {
  const n = str.length;
  const buf = Buffer.alloc((n + 1) * 2);
  for (let i = 0; i < n; i++) buf.writeUInt16LE(str.charCodeAt(i), i * 2);
  buf.writeUInt16LE(0, n * 2);
  return buf;
}

export async function runAsService({ onStart, onStop }) {
  try { process.stderr.write(`[win-svc] runAsService entered, platform=${process.platform}, isBun=${_isBun}\r\n`); } catch {}
  if (process.platform !== "win32") {
    process.stderr.write("[win-svc] Windows Service mode is only supported on Windows.\n");
    await onStart();
    return;
  }
  if (!_isBun) {
    process.stderr.write("[win-svc] bun:ffi required for SCM integration. Not running under Bun.\n");
    process.stderr.write("[win-svc] Falling back to console mode. Use nssm or winsw to wrap the Node.js process.\n");
    await onStart();
    return;
  }

  try { process.stderr.write("[win-svc] importing bun:ffi...\r\n"); } catch {}
  const { dlopen, FFIType, JSCallback, ptr } = await import("bun:ffi");
  try { process.stderr.write("[win-svc] bun:ffi imported\r\n"); } catch {}

  // ── Open advapi32.dll ──
  const advapi32 = dlopen("advapi32.dll", {
    StartServiceCtrlDispatcherW: { args: [FFIType.ptr], returns: FFIType.i32 },
    RegisterServiceCtrlHandlerExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetServiceStatus: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });

  const kernel32 = dlopen("kernel32.dll", {
    CreateEventW: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    SetEvent: { args: [FFIType.ptr], returns: FFIType.i32 },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });

  // ── Status buffer + helpers ──
  let _statusHandle = null;
  let _stopEvent = null;
  const _svcStatus = _keep(new ArrayBuffer(28));
  const _stView = new DataView(_svcStatus);

  function _reportStatus(state, exitCode = 0, waitHint = 0) {
    if (!_statusHandle) return;
    const controls = state === SERVICE_RUNNING
      ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN)
      : 0;
    _stView.setUint32(0,  SERVICE_WIN32_OWN_PROCESS, true);
    _stView.setUint32(4,  state, true);
    _stView.setUint32(8,  controls, true);
    _stView.setUint32(12, exitCode, true);
    _stView.setUint32(16, 0, true);
    _stView.setUint32(20, 0, true);
    _stView.setUint32(24, waitHint, true);
    advapi32.symbols.SetServiceStatus(_statusHandle, ptr(_svcStatus));
  }

  function _reportStopped(exitCode = 0) {
    _reportStatus(SERVICE_STOPPED, exitCode, 0);
  }

  // ── Control handler (called by SCM on stop / shutdown / interrogate) ──
  function _ctrlHandler(dwControl) {
    switch (dwControl) {
      case SERVICE_CONTROL_INTERROGATE:
        return NO_ERROR;
      case SERVICE_CONTROL_STOP:
      case SERVICE_CONTROL_SHUTDOWN:
        try { process.stderr.write(`[win-svc] received STOP/SHUTDOWN control=${dwControl}\r\n`); } catch {}
        _reportStatus(SERVICE_STOP_PENDING, NO_ERROR, 30000);
        try { onStop(); } catch {}
        if (_stopEvent) kernel32.symbols.SetEvent(_stopEvent);
        return NO_ERROR;
      default:
        return NO_ERROR; // ERROR_CALL_NOT_IMPLEMENTED — but returning NO_ERROR is safer
    }
  }

  // ── Service main (called by SCM after StartServiceCtrlDispatcherW) ──
  function _svcMain() {
    try { process.stderr.write("[win-svc] _svcMain entered\r\n"); } catch {}
    const ctrlCb = _keep(new JSCallback(_ctrlHandler, {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    }));

    const nameWide = _keep(_toWideBuf(SERVICE_NAME));

    _statusHandle = advapi32.symbols.RegisterServiceCtrlHandlerExW(
      ptr(nameWide),
      ctrlCb.ptr,
      null,
    );

    if (!_statusHandle) {
      process.stderr.write("[win-svc] RegisterServiceCtrlHandlerExW failed\n");
      return;
    }
    try { process.stderr.write("[win-svc] handler registered, reporting START_PENDING\r\n"); } catch {}

    _reportStatus(SERVICE_START_PENDING, NO_ERROR, 5000);

    // Run the user's start callback (starts the HTTP server)
    try { process.stderr.write("[win-svc] calling onStart...\r\n"); } catch {}
    try { onStart(); } catch (e) {
      process.stderr.write(`[win-svc] onStart failed: ${e}\n`);
      _reportStopped(1);
      return;
    }
    try { process.stderr.write("[win-svc] onStart returned, reporting RUNNING\r\n"); } catch {}

    _reportStatus(SERVICE_RUNNING);

    try { process.stderr.write("[win-svc] waiting on stop event...\r\n"); } catch {}
    kernel32.symbols.WaitForSingleObject(_stopEvent, 0xFFFFFFFF);
    try { process.stderr.write("[win-svc] stop event signaled, reporting STOPPED\r\n"); } catch {}
    _reportStopped();
  }

  // ── Stop event (manual-reset, initially non-signaled) ──
  _stopEvent = kernel32.symbols.CreateEventW(null, 1, 0, null);

  // ── Build SERVICE_TABLE_ENTRYW array ──
  const svcMainCb = _keep(new JSCallback(_svcMain, {
    args: [FFIType.u32, FFIType.ptr],
    returns: FFIType.void,
  }));

  const nameWide = _keep(_toWideBuf(SERVICE_NAME));
  const namePtrBig = BigInt(ptr(nameWide));
  const cbPtrBig    = BigInt(svcMainCb.ptr);

  const tableBuf = _keep(new ArrayBuffer(32)); // 2 entries * 16 bytes
  const tableView = new DataView(tableBuf);
  tableView.setBigUint64(0,  namePtrBig, true);
  tableView.setBigUint64(8,  cbPtrBig,    true);
  tableView.setBigUint64(16, 0n, true);
  tableView.setBigUint64(24, 0n, true);

  // ── Enter dispatch loop (blocks until service stops) ──
  try { process.stderr.write(`[win-svc] calling StartServiceCtrlDispatcherW, svcName=${SERVICE_NAME}\r\n`); } catch {}
  const dispatched = advapi32.symbols.StartServiceCtrlDispatcherW(ptr(tableBuf));
  try { process.stderr.write(`[win-svc] StartServiceCtrlDispatcherW returned ${dispatched}\r\n`); } catch {}

  if (dispatched === 0) {
    // Not running as service (error 1063 = ERROR_FAILED_SERVICE_CONTROLLER_CONNECT)
    // Someone ran --service from a console — fall back to normal console mode.
    process.stderr.write("[win-svc] Not started by SCM. Falling back to console mode.\n");
    await onStart();
  }

  // SCM dispatcher returned — service is stopping.
  if (_stopEvent) kernel32.symbols.CloseHandle(_stopEvent);
  _reportStopped();
  process.exit(0);
}
