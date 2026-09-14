'use strict';
// ExecStartPre: refuse to start if systemd's metadata denial or Unix ACLs do not work.
const net = require('node:net'); const { SOCKET_ROOT } = require('./scoped-credentials');
function connect(options) {
  return new Promise(resolve => {
    const socket = net.createConnection(options); const finish = code => { socket.destroy(); resolve(code); };
    socket.once('connect', () => finish('CONNECTED')); socket.once('error', error => finish(error.code));
    socket.setTimeout(1000, () => finish('TIMEOUT'));
  });
}
async function main(kind) {
  if (!['writer', 'reader'].includes(kind) || process.getuid() === 0) throw Error('audit_isolation_invalid');
  if (!['EACCES', 'EPERM'].includes(await connect({ host: '169.254.169.254', port: 80 }))) throw Error('audit_isolation_invalid');
  if (!['EACCES', 'EPERM', 'ENETUNREACH', 'EAFNOSUPPORT'].includes(await connect({ host: 'fd00:ec2::254', port: 80 }))) throw Error('audit_isolation_invalid');
  let ready = false;
  for (let i = 0; i < 20; i++) { if (await connect({ path: `${SOCKET_ROOT}/${kind}.sock` }) === 'CONNECTED') { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500)); }
  if (!ready || !['EACCES', 'EPERM'].includes(await connect({ path: `${SOCKET_ROOT}/${kind === 'writer' ? 'reader' : 'writer'}.sock` }))) throw Error('audit_isolation_invalid');
}
if (require.main === module) main(process.argv[2]).catch(() => { process.stderr.write('AUDIT_ISOLATION_CHECK_FAILED\n'); process.exitCode = 1; });
module.exports = { main };
