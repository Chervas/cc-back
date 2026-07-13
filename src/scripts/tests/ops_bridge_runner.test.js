'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  runOpsBridge,
  _activeChildren,
  _appendTail,
} = require('../../services/opsBridgeRunner.service');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    child.signalCode = signal;
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

async function testSuccessAndEnvironment() {
  let invocation = null;
  const spawnImpl = (binary, args, options) => {
    invocation = { binary, args, options };
    const child = fakeChild();
    setImmediate(() => {
      child.stdout.write('bridge ok');
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await runOpsBridge({
    scriptName: 'push_ops_summary.js',
    spawnImpl,
    backendRoot: '/tmp/clinicaclick-backend',
    nodeBinary: '/usr/bin/node-test',
    env: { OPS_INTERNAL_API_TOKEN: 'test-token', OPS_TEST_VALUE: 17 },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stdout_tail, 'bridge ok');
  assert.equal(invocation.binary, '/usr/bin/node-test');
  assert.deepEqual(invocation.args, ['/tmp/clinicaclick-backend/src/scripts/push_ops_summary.js']);
  assert.equal(invocation.options.cwd, '/tmp/clinicaclick-backend');
  assert.equal(invocation.options.env.OPS_TEST_VALUE, '17');
  assert.equal(invocation.options.env.OPS_VERBOSE_MODEL_LOAD, 'false');
  assert.equal(_activeChildren.size, 0);
}

async function testFailures() {
  await assert.rejects(
    () => runOpsBridge({ scriptName: 'not-allowed.js', env: { OPS_INTERNAL_API_TOKEN: 'x' } }),
    /no permitido/
  );
  await assert.rejects(
    () => runOpsBridge({ scriptName: 'push_ops_summary.js', env: { OPS_INTERNAL_API_TOKEN: '' } }),
    /OPS_INTERNAL_API_TOKEN es obligatorio/
  );

  const spawnImpl = () => {
    const child = fakeChild();
    setImmediate(() => {
      child.stderr.write('provider failed');
      child.exitCode = 2;
      child.emit('close', 2, null);
    });
    return child;
  };
  await assert.rejects(
    () => runOpsBridge({
      scriptName: 'push_ops_summary.js',
      spawnImpl,
      env: { OPS_INTERNAL_API_TOKEN: 'test-token' },
    }),
    (error) => error.message.includes('código 2') && error.stderrTail === 'provider failed'
  );
  assert.equal(_activeChildren.size, 0);
}

async function testTimeoutTerminatesChild() {
  let child = null;
  const spawnImpl = () => {
    child = fakeChild();
    return child;
  };
  // El runner usa un timeout `unref()` para no mantener vivo por sí solo el
  // backend. Un ChildProcess real conserva handles mientras está ejecutándose,
  // pero este fake no; el keepalive evita que Node termine el test antes de
  // comprobar de verdad el timeout y la señal de terminación.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      () => runOpsBridge({
        scriptName: 'push_ops_summary.js',
        spawnImpl,
        timeoutMs: 1000,
        env: { OPS_INTERNAL_API_TOKEN: 'test-token' },
      }),
      /superó 1000 ms/
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(_activeChildren.size, 0);
}

async function run() {
  await testSuccessAndEnvironment();
  await testFailures();
  await testTimeoutTerminatesChild();
  assert.equal(_appendTail('', 'x'.repeat(70 * 1024)).length, 64 * 1024);
  console.log('ops_bridge_runner.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
