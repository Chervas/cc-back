'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const crypto=require('node:crypto'),{Readable}=require('node:stream');
const {args,encryptStream,verifyCipher}=require('../meta-clinical-schema-release');
test('public Meta operator accepts only its explicit actions and protected recovery directory',()=>{
  const source=path.resolve(__dirname,'../../..'),dir='/var/lib/clinicaclick-schema-recovery/meta-fixture';
  assert.equal(args(['plan','--source',source,'--dir',dir]).action,'plan');
  for(const argv of [ ['apply-dev','--source',source,'--dir',dir], ['apply','--source',source,'--dir','/tmp/public-plan'],
    ['plan','--source',source,'--dir',dir,'--runtime','dev'], ['backup','--source',source,'--dir',dir+'/nested'],
    ['apply','--source',source,'--dir','/var/lib/clinicaclick-schema-recovery/..'] ])assert.throws(()=>args(argv));
});
test('point backup encrypts the stream and rejects changed ciphertext, key, tag or plaintext receipt',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meta-point-backup-')),file=path.join(dir,'backup.enc');
  try{
    const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),plain=Buffer.from('FICTITIOUS_LEGACY_TOKEN\nClínica ñ\n');
    const receipt=await encryptStream(Readable.from([plain.subarray(0,9),plain.subarray(9)]),file,key,iv);
    assert.equal(fs.statSync(file).mode&0o777,0o600);assert(!fs.readFileSync(file).includes(plain));
    await verifyCipher(file,key,receipt);
    await assert.rejects(verifyCipher(file,crypto.randomBytes(32),receipt));
    await assert.rejects(verifyCipher(file,key,{...receipt,tag:'00'.repeat(16)}));
    await assert.rejects(verifyCipher(file,key,{...receipt,plaintextSha256:'00'.repeat(32)}));
    const altered=fs.readFileSync(file);altered[0]^=1;fs.writeFileSync(file,altered);
    await assert.rejects(verifyCipher(file,key,receipt),/backup_changed/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
