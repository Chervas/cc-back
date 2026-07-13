'use strict';

const path = require('path');
const { spawn } = require('child_process');

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const ALLOWED_SCRIPTS = new Set([
  'push_ops_global_discovery.js',
  'push_ops_summary.js',
  'push_ops_google_business_profile.js',
  'push_ops_search_console.js',
]);
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const OUTPUT_TAIL_BYTES = 64 * 1024;
const ACTIVE_CHILDREN = new Set();
let exitHookInstalled = false;

const appendTail = (current, chunk) => {
  const combined = `${current}${String(chunk || '')}`;
  return combined.length > OUTPUT_TAIL_BYTES
    ? combined.slice(combined.length - OUTPUT_TAIL_BYTES)
    : combined;
};

const normalizeEnv = (overrides = {}) => Object.fromEntries(
  Object.entries(overrides)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)])
);

const terminateChild = (child, signal = 'SIGTERM') => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch (_error) {
    return false;
  }
};

const terminateActiveChildren = (signal = 'SIGTERM') => {
  let terminated = 0;
  for (const child of ACTIVE_CHILDREN) {
    if (terminateChild(child, signal)) terminated += 1;
  }
  return terminated;
};

const installExitHook = () => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` es síncrono: solo se reenvía la señal, sin abrir trabajo nuevo.
  // Cubre reinicios normales/ordenados de PM2 y evita dejar el bridge vivo
  // mientras JobRequest recupera y reintenta el mismo trabajo.
  process.once('exit', () => terminateActiveChildren('SIGTERM'));
};

async function runOpsBridge(options = {}) {
  const scriptName = String(options.scriptName || '').trim();
  if (!ALLOWED_SCRIPTS.has(scriptName)) {
    throw new Error(`OPS bridge no permitido: ${scriptName || '(vacío)'}`);
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const backendRoot = path.resolve(options.backendRoot || BACKEND_ROOT);
  const scriptPath = path.join(backendRoot, 'src', 'scripts', scriptName);
  const spawnImpl = options.spawnImpl || spawn;
  const childEnv = {
    ...process.env,
    ...normalizeEnv(options.env),
    OPS_VERBOSE_MODEL_LOAD: 'false',
  };
  if (!String(childEnv.OPS_INTERNAL_API_TOKEN || '').trim()) {
    throw new Error('OPS_INTERNAL_API_TOKEN es obligatorio para ejecutar bridges OPS');
  }
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawnImpl(options.nodeBinary || process.execPath, [scriptPath], {
      cwd: backendRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ACTIVE_CHILDREN.add(child);
    installExitHook();
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const resolveOnce = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child, 'SIGTERM');
      setTimeout(() => {
        terminateChild(child, 'SIGKILL');
      }, 10000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk);
      process.stdout.write(`[ops:${scriptName}] ${chunk}`);
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk);
      process.stderr.write(`[ops:${scriptName}] ${chunk}`);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      ACTIVE_CHILDREN.delete(child);
      rejectOnce(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      ACTIVE_CHILDREN.delete(child);
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (timedOut) {
        rejectOnce(new Error(`OPS bridge ${scriptName} superó ${timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        const error = new Error(
          `OPS bridge ${scriptName} terminó con código ${code ?? 'null'}${signal ? ` (${signal})` : ''}`
        );
        error.stdoutTail = stdoutTail;
        error.stderrTail = stderrTail;
        rejectOnce(error);
        return;
      }
      resolveOnce({
        status: 'completed',
        script: scriptName,
        elapsed_seconds: elapsedSeconds,
        stdout_tail: stdoutTail,
        stderr_tail: stderrTail,
      });
    });
  });
}

module.exports = {
  ALLOWED_SCRIPTS,
  BACKEND_ROOT,
  runOpsBridge,
  _appendTail: appendTail,
  _normalizeEnv: normalizeEnv,
  _terminateChild: terminateChild,
  _terminateActiveChildren: terminateActiveChildren,
  _activeChildren: ACTIVE_CHILDREN,
};
