'use strict';
// Narrow sealed release: diagnostics only. No configuration, payload, lease,
// credential, ownership, provider API or schema modifications.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {createHash}=require('node:crypto');
const BASE='/opt/clinicaclick-whatsapp-inbox/release-routing-review-e2612c09-20261006';
const TARGET='/opt/clinicaclick-whatsapp-inbox/release-user-identity-20261012-v1';
const CONFIG='/etc/clinicaclick-whatsapp-inbox/config.json';
const SERVICE='clinicaclick-whatsapp-inbox.service';
const NODE='/opt/clinicaclick-audit/node-v24.21.0-recovery1/bin/node';
const DROP='/etc/systemd/system/'+SERVICE+'.d/zzzzzzzzzzzz-user-identity-20261012.conf';
const PIN={
  'whatsapp-inbox.js':'02894a917e023121e5838c60faebb5f5fff52331a8ca0eb2f8ff1d4ee2bbd0c5',
  'whatsapp-inbox-review.js':'db8b36cf2df0d0725211ea4e279fa0bbd23c137c36e03e829a52d597198a196e',
};
const hash=value=>createHash('sha256').update(value).digest('hex');
const run=args=>cp.execFileSync(args[0],args.slice(1),{stdio:['ignore','pipe','pipe'],timeout:30000}).toString();
function checkBase(){
  if(process.getuid()!==0||!run(['systemctl','show',SERVICE,'-p','ExecStart']).includes(BASE+'/src/whatsapp-inbox-main.js'))throw Error('active_release_changed');
  for(const [name,digest]of Object.entries(PIN))if(hash(fs.readFileSync(BASE+'/src/'+name))!==digest)throw Error('baseline_hash_changed');
}
function prepare(bundle){
  checkBase();if(fs.existsSync(TARGET)||Object.keys(bundle.files).sort().join(',')!==Object.keys(PIN).sort().join(','))throw Error('candidate_invalid');
  fs.cpSync(BASE,TARGET,{recursive:true});
  for(const [name,entry]of Object.entries(bundle.files)){
    const data=Buffer.from(entry.data,'base64');if(hash(data)!==entry.sha256)throw Error('artifact_hash_invalid');
    fs.writeFileSync(TARGET+'/src/'+name,data,{mode:0o644});run([NODE,'--check',TARGET+'/src/'+name]);
  }
  fs.writeFileSync(TARGET+'/identity-verification.cjs',Buffer.from(bundle.test,'base64'),{mode:0o600,flag:'wx'});
  fs.writeFileSync(TARGET+'/identity-release.json',JSON.stringify({configSha:hash(fs.readFileSync(CONFIG)),files:Object.fromEntries(Object.entries(bundle.files).map(([name,entry])=>[name,entry.sha256]))}),{mode:0o600,flag:'wx'});
  return {prepared:true,target:TARGET};
}
function verify(){
  checkBase();const manifest=JSON.parse(fs.readFileSync(TARGET+'/identity-release.json'));
  if(manifest.configSha!==hash(fs.readFileSync(CONFIG)))throw Error('configuration_changed');
  for(const [name,digest]of Object.entries(manifest.files))if(hash(fs.readFileSync(TARGET+'/src/'+name))!==digest)throw Error('candidate_hash_changed');
  const result=JSON.parse(run([NODE,TARGET+'/identity-verification.cjs',TARGET]));
  if(result.passed!==true||result.metaCalls!==0)throw Error('verification_failed');
  fs.writeFileSync(TARGET+'/identity-verification.json',JSON.stringify({manifestSha:hash(fs.readFileSync(TARGET+'/identity-release.json')),result}),{mode:0o600});
  return result;
}
function install(){
  checkBase();const manifest=JSON.parse(fs.readFileSync(TARGET+'/identity-release.json'));
  const proof=JSON.parse(fs.readFileSync(TARGET+'/identity-verification.json'));
  if(proof.manifestSha!==hash(fs.readFileSync(TARGET+'/identity-release.json'))||!proof.result.passed)throw Error('verification_not_current');
  if(manifest.configSha!==hash(fs.readFileSync(CONFIG))||fs.existsSync(DROP))throw Error('configuration_or_dropin_changed');
  for(const [name,digest]of Object.entries(manifest.files))if(hash(fs.readFileSync(TARGET+'/src/'+name))!==digest)throw Error('candidate_hash_changed');
  fs.mkdirSync(path.dirname(DROP),{recursive:true});
  run(['systemctl','stop',SERVICE]);
  try{
    fs.writeFileSync(DROP,'[Service]\nExecStart=\nExecStart='+NODE+' '+TARGET+'/src/whatsapp-inbox-main.js '+CONFIG+'\n',{mode:0o644,flag:'wx'});
    run(['systemctl','daemon-reload']);run(['systemctl','start',SERVICE]);
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if(run(['systemctl','is-active',SERVICE]).trim()==='active'){
        cp.execFileSync('sleep',['1']);
        if(run(['systemctl','is-active',SERVICE]).trim()==='active'&&hash(fs.readFileSync(CONFIG))===manifest.configSha)return {installed:true,target:TARGET,configurationUnchanged:true};
      }
      cp.execFileSync('sleep',['1']);
    }
    throw Error('readiness_failed');
  }catch(error){
    try{run(['systemctl','stop',SERVICE]);}catch{}
    fs.rmSync(DROP,{force:true});run(['systemctl','daemon-reload']);run(['systemctl','start',SERVICE]);
    throw Error('publication_failed_rolled_back');
  }
}
if(require.main===module){
  try{const action=process.argv[2];console.log(JSON.stringify(action==='prepare'?prepare(JSON.parse(fs.readFileSync(process.argv[3]))):action==='verify'?verify():action==='install'?install():(()=>{throw Error('invalid_action')})()));}
  catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
}
module.exports={prepare,verify,install};
