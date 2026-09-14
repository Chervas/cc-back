'use strict';
// ExecStartPre: refuse to start if systemd's metadata denial or Unix ACLs do not work.
const net = require('node:net'); const { SOCKET_ROOT } = require('./scoped-credentials');
function connect(options) {
  return new Promise(resolve => {
    const socket = net.createConnection(options); let done = false;
    const finish = code => { if (done) return; done = true; socket.destroy(); resolve(code); };
    socket.once('connect', () => finish('CONNECTED')); socket.once('error', error => finish(error.code));
    socket.setTimeout(1000, () => finish('TIMEOUT'));
  });
}
async function loopbackProbe(host) {
  // Keep our own listener alive: an unavailable endpoint cannot impersonate a filter.
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  try { return await connect({ host, port: server.address().port }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
async function verifyNetworkIsolation(probe = connect, localProbe = loopbackProbe) {
  const denied = ['EACCES', 'EPERM', 'TIMEOUT'];
  // systemd's cgroup packet filter drops packets; TCP reports TIMEOUT on AL2023.
  // Require an allowed listener and a denied listener before accepting that result.
  if (await localProbe('127.0.0.1') !== 'CONNECTED') throw Error('audit_isolation_invalid');
  if (!denied.includes(await localProbe('127.0.0.2'))) throw Error('audit_isolation_invalid');
  if (!denied.includes(await probe({ host: '169.254.169.254', port: 80 }))) throw Error('audit_isolation_invalid');
  if (![...denied, 'ENETUNREACH', 'EAFNOSUPPORT'].includes(await probe({ host: 'fd00:ec2::254', port: 80 }))) throw Error('audit_isolation_invalid');
}
async function main(kind) {
  if (!['writer', 'reader'].includes(kind) || process.getuid() === 0) throw Error('audit_isolation_invalid');
  await verifyNetworkIsolation();
  let ready = false;
  for (let i = 0; i < 20; i++) { if (await connect({ path: `${SOCKET_ROOT}/${kind}.sock` }) === 'CONNECTED') { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500)); }
  if (!ready || !['EACCES', 'EPERM'].includes(await connect({ path: `${SOCKET_ROOT}/${kind === 'writer' ? 'reader' : 'writer'}.sock` }))) throw Error('audit_isolation_invalid');
}
if (require.main === module) main(process.argv[2]).catch(() => { process.stderr.write('AUDIT_ISOLATION_CHECK_FAILED\n'); process.exitCode = 1; });
module.exports = { main, verifyNetworkIsolation };
