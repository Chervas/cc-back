'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
require('./fixtures/campaign_offline_runtime.cjs');
const cli=require('../meta-lead-historical-recovery');
const base=['--scan','--runtime','staging','--actor-id','99','--clinic-id','66','--clinic-id','72','--page-asset-id','31','--account-asset-id','32',
  '--form-id','702','--start-date','2026-11-08','--end-date','2026-11-12','--start-instant','2026-11-08T23:00:00Z','--end-instant','2026-11-12T12:00:00Z'];
const input={actorId:99,clinicIds:[66,72],pageAssetId:31,accountAssetId:32,formId:'702',runtime:'staging',startDate:'2026-11-08',endDate:'2026-11-12',
  startInstant:'2026-11-08T23:00:00.000Z',endInstant:'2026-11-12T12:00:00.000Z',timeZone:'Europe/Madrid',acceptedJobIds:[]};
const report=()=>({version:2,mode:'scan',complete:true,batchId:'11111111-1111-4111-8111-111111111111',input,authorityDigest:'a'.repeat(64),
  observed:1,results:[{externalId:'701',source:'provider_form_recovery',status:'missing'}],messagesSent:0});
const hash=value=>createHash('sha256').update(value).digest('hex');
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'meta-recovery-cli-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function plan(t){const p=temp(t),file=path.join(p,'source-plan.json'),raw=JSON.stringify(report());fs.writeFileSync(file,raw,{mode:0o600});return {p,file,sha:hash(raw)};}
test('no default provider scan or arbitrary lead/token override exists; modes and every scope are explicit',()=>{
  for(const args of [[],['--output','/tmp/unsafe'],base,base.concat('--scan'),base.concat('--token','PRIVATE','--output','/tmp/new'),
    base.concat('--output','/tmp/new','--actor-id','1'),['--apply','--runtime','staging','--output','/tmp/new','--plan','/tmp/x']])assert.throws(()=>cli.parseArgs(args));
  const parsed=cli.parseArgs(base.concat('--accepted-job-id','88','--output','/tmp/new-operation'));
  assert.equal(parsed.mode,'scan');assert.deepEqual(parsed.acceptedJobIds,[88]);
});
test('apply pins exact private plan bytes, rejects symlinks/shared plans and refuses a modified digest before any runtime models',async t=>{
  const f=plan(t);assert.equal(cli.readPlan(f.file,f.sha).input.expectedLeadIds[0],'701');
  fs.appendFileSync(f.file,' ');assert.throws(()=>cli.readPlan(f.file,f.sha),/plan_changed/);
  fs.chmodSync(f.file,0o644);assert.throws(()=>cli.readPlan(f.file,hash(fs.readFileSync(f.file))),/private_required/);
  fs.chmodSync(f.file,0o600);const link=path.join(f.p,'link.json');fs.symlinkSync(f.file,link);assert.throws(()=>cli.readPlan(link,f.sha),/private_required/);
  let loaded=false;await assert.rejects(cli.main(['--apply','--runtime','staging','--plan',f.file,'--expected-sha256',f.sha,'--output',path.join(f.p,'not-created')],
    {loadModels:()=>{loaded=true;throw Error('must not load');}}));
  assert.equal(loaded,false);assert.equal(fs.existsSync(path.join(f.p,'not-created')),false);
});
test('operation directories are newly reserved and private; a pre-existing path cannot overwrite an earlier journal',t=>{
  const p=temp(t),dir=path.join(p,'operation'),output=cli.reserveOutput(dir);
  try {output.plan(report());output.report({complete:false});assert.equal(fs.statSync(dir).mode&0o777,0o700);
    for(const name of ['journal.jsonl','report.json','plan.json'])assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o600);
    assert.throws(()=>cli.reserveOutput(dir));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'plan.json'))).mode,'scan');
  } finally{output.close();}
});
test('runtime ownership and namespace reject root and gateway rather than borrowing a different environment',t=>{
  const p=temp(t);fs.writeFileSync(path.join(p,'.env'),'FIXTURE_ONLY=true\n',{mode:0o600});
  const uid=process.getuid();assert.throws(()=>cli.assertRuntime('staging',{cwd:p,uid:0,env:{RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging'}}),/runtime_uid/);
  assert.throws(()=>cli.assertRuntime('staging',{cwd:p,uid,env:{RUNTIME_ROLE:'gateway',JOB_RUNTIME_NAMESPACE:'staging'}}),/runtime_mismatch/);
  assert.throws(()=>cli.assertRuntime('staging',{cwd:p,uid,env:{RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'dev'}}),/runtime_mismatch/);
  cli.assertRuntime('staging',{cwd:p,uid,env:{RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging'}});
});
test('full scan CLI reserves output before work, fsyncs an ID-only plan and prints only counts plus digest',async t=>{
  const p=temp(t),directory=path.join(p,'scan-operation'),logs=[],original=console.log;let closed=false;
  console.log=value=>logs.push(value);
  try{
    const summary=await cli.main(base.concat('--output',directory),{dotenv:()=>{},assertRuntime:()=>{},loadModels:()=>({sequelize:{close:async()=>{closed=true;}}}),
      createReader:()=>({}),createService:({journal})=>({run:async()=>{assert(fs.existsSync(path.join(directory,'journal.jsonl')));await journal({phase:'started'});return report();}})});
    assert.equal(summary.planSha256,hash(fs.readFileSync(path.join(directory,'plan.json'))));assert.equal(summary.counts.missing,1);
    const printed=JSON.parse(logs[0]);assert.equal(printed.counts.missing,1);assert.equal(printed.externalId,undefined);assert(!logs[0].includes('701'));assert.equal(closed,true);
  }finally{console.log=original;}
});
