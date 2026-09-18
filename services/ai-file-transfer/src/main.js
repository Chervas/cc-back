'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { TransferStore } = require('./store');
const { controlHandler, downloadHandler, server } = require('./server');
const C = require('./contract');
function validateConfig(value) {
  if (!C.exact(value, ['version', 'environment', 'origin', 'directory', 'controlSocket', 'controlGroupId', 'port'])
    || value.version !== 1 || !['dev', 'staging'].includes(value.environment) || !path.isAbsolute(value.directory)
    || !path.isAbsolute(value.controlSocket) || value.controlSocket.length > 100
    || !Number.isInteger(value.controlGroupId) || value.controlGroupId < 1
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) C.fail('invalid_config');
  C.origin(value.origin); return value;
}
async function main(filename) {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.mode & 0o077 || ![0, process.getuid()].includes(stat.uid) || stat.size > 8192 || await fsp.realpath(filename) !== filename) C.fail('invalid_config');
  const config = validateConfig(JSON.parse(await fsp.readFile(filename, 'utf8')));
  const parent = path.dirname(config.controlSocket), parentInfo = await fsp.lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid() || parentInfo.mode & 0o027
    || await fsp.realpath(parent) !== parent) C.fail('invalid_config');
  const store = new TransferStore(config); let ready = false, control, timer;
  const handler = downloadHandler(store);
  const download = server((req, res) => {
    if (!ready) { res.writeHead(503, { 'Cache-Control': 'no-store', Connection: 'close' }); res.end(); return; }
    return handler(req, res);
  });
  const listen = (instance, ...args) => new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(...args, resolve); });
  const closeServer = instance => new Promise(resolve => { if (!instance?.listening) return resolve(); instance.close(resolve); instance.closeAllConnections(); });
  try {
    // A fixed port establishes one owner before state recovery touches files.
    await listen(download, config.port, '127.0.0.1'); await store.open();
    if (fs.existsSync(config.controlSocket)) {
      const info = await fsp.lstat(config.controlSocket);
      if (!info.isSocket() || info.uid !== process.getuid()) C.fail('invalid_config');
      const inUse = await new Promise(resolve => { const socket = net.connect(config.controlSocket);
        socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', error => resolve(error.code !== 'ECONNREFUSED'));
        socket.setTimeout(1000, () => { socket.destroy(); resolve(true); }); });
      if (inUse) C.fail('invalid_config'); await fsp.unlink(config.controlSocket);
    }
    control = server(controlHandler(store), { control: true }); await listen(control, config.controlSocket);
    await fsp.chown(config.controlSocket, process.getuid(), config.controlGroupId); await fsp.chmod(config.controlSocket, 0o660);
    ready = true;
    timer = setInterval(() => store.cleanup().catch(() => { process.stderr.write('AI_TRANSFER_CLEANUP_FAILED\n'); }), 10000); timer.unref();
    let closing;
    return { store, download, control, close: () => closing ||= (async () => {
      ready = false; clearInterval(timer); for (const row of store.rows.values()) for (const cancel of row.consumers) cancel();
      await Promise.all([closeServer(control), closeServer(download)]); await fsp.unlink(config.controlSocket).catch(() => {});
    })() };
  } catch (error) { clearInterval(timer); await Promise.all([closeServer(control), closeServer(download)]); throw error; }
}
if (require.main === module) main(process.argv[2]).then(runtime => {
  process.stdout.write('AI_TRANSFER_READY\n');
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; }); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('AI_TRANSFER_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig };
