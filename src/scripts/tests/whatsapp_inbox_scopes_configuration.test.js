'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function configuration(staticScopes,activatedScopes){
  const source=fs.readFileSync(require.resolve('../../lib/whatsappInboxScopes'),'utf8');
  const fakeFs={statSync:()=>({isFile:()=>true,mode:0o600,size:100}),
    realpathSync:path=>path,readFileSync:()=>Buffer.from(JSON.stringify({version:1,scopes:staticScopes}))};
  const sandbox={module:{exports:{}},require:name=>name==='node:fs'?fakeFs
    :name==='./whatsappActivationCatalog'?{read:()=>({}),scopes:()=>activatedScopes}
      :name==='./whatsappInboxImport'?require('../../lib/whatsappInboxImport'):require(name)};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  return sandbox.module.exports.configuration({RUNTIME_NAMESPACE:'staging',
    WHATSAPP_INBOX_SCOPES_FILE:'/etc/clinicaclick-whatsapp-inbox/staging/scopes.json'});
}
const old={assetId:382,wabaId:'101',phoneId:'201',clinicIds:[19]};
const renewed={...old,wabaId:'102',phoneId:'202'};
const other={assetId:386,wabaId:'103',phoneId:'203',clinicIds:[59]};

test('verified activation replaces a stale static identity for the same asset',()=>{
  const result=configuration([old,other],[renewed]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.scopes)),[renewed,other].sort((a,b)=>a.phoneId.localeCompare(b.phoneId)));
});
test('a different asset cannot claim an already configured provider phone',()=>{
  assert.throws(()=>configuration([old],[{...other,phoneId:old.phoneId}]),/review_required/);
});
