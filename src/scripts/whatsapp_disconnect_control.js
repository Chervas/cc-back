'use strict';

const fs = require('node:fs');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const REVOKE = 'meta.whatsapp.authorized.phone.revoke.v1';
function validate(command) {
  const keys = ['requestId', 'tenantRef', 'connectionRef', 'assetRef', 'operation', 'payload'];
  if (!command || Object.keys(command).sort().join(',') !== keys.sort().join(',')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(command.requestId)
    || !/^clinic:[1-9][0-9]{0,9}$/.test(command.tenantRef)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(command.connectionRef)
    || !/^wa-phone:[1-9][0-9]{0,29}$/.test(command.assetRef)
    || command.operation !== REVOKE || !command.payload || Array.isArray(command.payload)
    || Object.keys(command.payload).length) throw Error('invalid_request');
  return command;
}
function privateFile(file, max) {
  const stat = fs.statSync(file);
  if (fs.realpathSync(file) !== file || stat.uid !== 0 || stat.mode & 0o077 || stat.size > max || !stat.isFile()) throw Error('invalid_config');
  return fs.readFileSync(file);
}
async function main() {
  if (process.getuid() !== 0 || process.argv.length !== 2) throw Error('invalid_runtime');
  let input = '';
  const inputTimeout = setTimeout(() => process.exit(1), 2000);
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 4096) throw Error('invalid_request'); }
  clearTimeout(inputTimeout);
  const command = validate(JSON.parse(input));
  const config = JSON.parse(privateFile('/etc/clinicaclick-whatsapp-authorized/control/revoke.json', 4096));
  let key, ca;
  try {
    key = privateFile('/etc/clinicaclick-whatsapp-authorized/control/signing.pem', 8192);
    ca = fs.readFileSync('/etc/clinicaclick-whatsapp-authorized/staging/ca.pem');
    const client = createIntegrationsBrokerClient({ ...config, privateKey: key, ca, timeoutMs: 8000 });
    const result = await client.execute(command);
    if (result.requestId !== command.requestId || result.data?.revoked !== true || Object.keys(result.data).join(',') !== 'revoked') throw Error('invalid_result');
    process.stdout.write(JSON.stringify({ requestId: result.requestId, data: { revoked: true }, replayed: result.replayed }));
  } finally { key?.fill(0); ca?.fill(0); }
}
if (require.main === module) main().catch(() => { process.stderr.write('WHATSAPP_DISCONNECT_NOT_CONFIRMED\n'); process.exitCode = 1; });
module.exports = { validate };
