'use strict';

// Controlled host install, not an API hook. All executable dependencies are
// copied to a root-owned tree; the signing key stays root-only in /etc.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '../..');
const destination = '/opt/clinicaclick-whatsapp-disconnect';
if (process.getuid() !== 0 || process.argv.length !== 5) throw Error('Expected root host install: keyId audience public-key-SHA256');
const [keyId, audience, fingerprint] = process.argv.slice(2);
if (![keyId, audience].every(v => /^[A-Za-z0-9_.:-]{1,128}$/.test(v)) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error('Invalid pinned metadata');
const key = fs.readFileSync('/etc/clinicaclick-whatsapp-authorized/control/signing.pub');
const actual = crypto.createHash('sha256').update(crypto.createPublicKey(key).export({ type:'spki',format:'der' })).digest('hex');
if (actual !== fingerprint) throw Error('Control principal fingerprint mismatch');
let privateKey;
try {
  privateKey=fs.readFileSync('/etc/clinicaclick-whatsapp-authorized/control/signing.pem');
  const signedBy=crypto.createHash('sha256').update(crypto.createPublicKey(crypto.createPrivateKey(privateKey)).export({type:'spki',format:'der'})).digest('hex');
  if(signedBy!==actual)throw Error('Control private/public identity mismatch');
} finally {privateKey?.fill(0);}
const config = JSON.parse(fs.readFileSync('/etc/clinicaclick-whatsapp-authorized/staging/config.json','utf8'));
require(source + '/src/lib/integrationsBrokerClient');
const dependencies = Object.keys(require.cache).filter(file => file.startsWith(source + '/') && file !== __filename);
const files = [...new Set(['src/scripts/whatsapp_disconnect_control.js', ...dependencies.map(file => path.relative(source,file))])];
if (files.some(file => !/^(src\/lib\/integrationsBrokerClient|services\/integrations-broker\/src\/[a-z-]+|src\/scripts\/whatsapp_disconnect_control)\.js$/.test(file))) throw Error('Unexpected executable dependency');
if (fs.existsSync(path.join(destination,'READY'))) fs.unlinkSync(path.join(destination,'READY'));
for (const file of files) {
  const target = path.join(destination,file), directory = path.dirname(target);
  fs.mkdirSync(directory,{recursive:true,mode:0o755});
  for (let d = directory; d.startsWith(destination); d = path.dirname(d)) { fs.chownSync(d,0,0); fs.chmodSync(d,0o755); }
  fs.copyFileSync(path.join(source,file),target); fs.chownSync(target,0,0); fs.chmodSync(target,0o644);
}
const privateConfig='/etc/clinicaclick-whatsapp-authorized/control/revoke.json';
fs.writeFileSync(privateConfig,JSON.stringify({origin:config.origin,keyId,audience}),{mode:0o600}); fs.chownSync(privateConfig,0,0); fs.chmodSync(privateConfig,0o600);
const sudoersSource=path.join(source,'ops/security/whatsapp-disconnect.sudoers');
execFileSync('/usr/sbin/visudo',['-cf',sudoersSource],{stdio:'pipe'});
const sudoers='/etc/sudoers.d/clinicaclick-whatsapp-disconnect';
fs.copyFileSync(sudoersSource,sudoers); fs.chownSync(sudoers,0,0); fs.chmodSync(sudoers,0o440);
const ready=path.join(destination,'READY'); fs.writeFileSync(ready,JSON.stringify({version:1,files:files.length,controlFingerprint:actual})+'\n',{mode:0o644}); fs.chownSync(ready,0,0);
console.log(JSON.stringify({installed:true,rootOwnedExecutableFiles:files.length,controlKeyReadableByApi:false,operation:'phone.revoke.v1'}));
