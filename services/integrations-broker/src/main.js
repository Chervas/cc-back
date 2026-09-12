'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrokerStore } = require('./store');
const { Broker } = require('./broker');
const { createServer } = require('./server');
const { createFictitiousSecretStore } = require('./secrets');

function readPrivate(filename) {
  if (!path.isAbsolute(filename) || fs.lstatSync(filename).isSymbolicLink()
    || (fs.statSync(filename).mode & 0o077) !== 0) throw Error('Private absolute file required');
  return fs.readFileSync(filename);
}
function main(filename) {
  const config = JSON.parse(readPrivate(filename));
  if (!config.policy.connections.every(item => item.provider === 'fictitious')) throw Error('Real provider rollout is not configured');
  const port = config.port ?? 8443;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port');
  const store = new BrokerStore(config.stateFile);
  const broker = new Broker({ store, policy: config.policy, secrets: createFictitiousSecretStore() });
  const server = createServer(broker, { cert: readPrivate(config.tlsCertFile), key: readPrivate(config.tlsKeyFile) });
  // No AWS/SSO/provider credentials, background delivery, scheduler or legacy bootstrap here.
  server.listen(port, config.listenAddress || '127.0.0.1');
  const close = () => server.close(() => { store.close(); process.exitCode = 0; });
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { server, store };
}
if (require.main === module) {
  try { main(process.argv[2]); }
  catch { process.stderr.write('BROKER_START_FAILED\n'); process.exitCode = 1; }
}
module.exports = { main };
