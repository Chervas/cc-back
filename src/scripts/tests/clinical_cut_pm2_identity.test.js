'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {observePm2Application}=require('../../lib/clinicalCutProcessIdentity');
const {recoverStoppedParticipants}=require('../../lib/metaClinicalCutRecovery');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('owned PM2 npm wrapper and Node child remain distinct through preserve, stop and recovery',async()=>{
 const root=fs.mkdtempSync('/tmp/cc-cut-pm2-');fs.chmodSync(root,0o700);
 const pm2Home=path.join(root,'pm2'),app=path.join(root,'application');fs.mkdirSync(pm2Home,{mode:0o700});fs.mkdirSync(app);fs.mkdirSync(path.join(app,'src'));
 fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({scripts:{start:'node src/app.js'}}));
 fs.writeFileSync(path.join(app,'src/app.js'),"'use strict';setInterval(()=>{},1000);\n");
 const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:process.env.HOME,PM2_HOME:pm2Home,PM2_SILENT:'true'};
 const run=async args=>{assert.equal(env.PM2_HOME,pm2Home);return(await promisify(execFile)(process.execPath,['/usr/lib/node_modules/pm2/bin/pm2',...args],{env,cwd:app,timeout:12000})).stdout.trim();};
 const inspect=async()=>observePm2Application({rows:JSON.parse(await run(['jlist'])),id:'owned-clinical-cut-qa',root:app});
 const wait=async state=>{const until=Date.now()+10000;for(;;){const now=await inspect();if(now.state===state)return now;assert(Date.now()<until);await delay(30);}};
 const started=[];let original,resumed;
 try{
  await run(['start','/usr/bin/npm','--interpreter','none','--name','owned-clinical-cut-qa','--','start']);original=await wait('running');
  assert.notEqual(original.pid,original.identity.application.pid);assert(original.identity.lineage.length>=1);
  const participant={id:'owned-clinical-cut-qa',originalPid:original.pid,originalIdentity:original.identity,stopRequested:false};
  const options={participants:[participant],inspect,start:async()=>{started.push('start');await run(['restart','owned-clinical-cut-qa']);await wait('running');},verify:async()=>{assert.equal((await inspect()).state,'running');}};
  const preserved=await recoverStoppedParticipants(options);assert.equal(preserved[0].action,'preserved');assert.deepEqual(started,[]);
  await assert.rejects(recoverStoppedParticipants({...options,participants:[{...participant,originalPid:original.identity.application.pid}]}),/unexpected_process_state/);
  assert.deepEqual(started,[],'The previous binding fails with real PM2, without restarting the untouched API');
  participant.stopRequested=true;await run(['stop','owned-clinical-cut-qa']);assert.deepEqual(await wait('stopped'),{state:'stopped',pid:0});
  const recovered=await recoverStoppedParticipants(options);assert.equal(recovered[0].action,'started');assert.deepEqual(started,['start']);resumed=await inspect();
  assert.notEqual(resumed.pid,original.pid);assert.notEqual(resumed.identity.application.pid,original.identity.application.pid);
  console.log(JSON.stringify({kind:'owned_pm2_identity',root,managerPid:original.pid,applicationPid:original.identity.application.pid,resumedManagerPid:resumed.pid,resumedApplicationPid:resumed.identity.application.pid,success:true}));
 }finally{
  await run(['kill']);
  const until=Date.now()+5000;
  for(const p of [original?.identity.manager,original?.identity.application,resumed?.identity.manager,resumed?.identity.application].filter(Boolean)){
   while(fs.existsSync('/proc/'+p.pid)){assert(Date.now()<until,'owned_process_cleanup_timeout');await delay(20);}
  }
 }
});
