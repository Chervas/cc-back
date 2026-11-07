'use strict';
const A=require('./meta-marketing-agency-contract'),C=require('./meta-marketing-oauth-contract'),B=require('./meta-marketing-business-contract'),M=require('./meta-marketing-contract');
const {fail}=require('./errors'),{eventFor}=require('./audit'),{tokenText}=require('./whatsapp-secrets');
function createAgencyBootstrap({store,policy,now=Date.now}){
 store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_agency_bootstraps(id TEXT PRIMARY KEY,config_digest TEXT NOT NULL,business TEXT NOT NULL,app TEXT NOT NULL,name TEXT NOT NULL UNIQUE,baseline_users TEXT NOT NULL,system_user TEXT,state TEXT NOT NULL,create_intent_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS meta_marketing_agency_bootstrap_steps(bootstrap TEXT NOT NULL,step TEXT NOT NULL,intent_at INTEGER NOT NULL,ack_at INTEGER,state TEXT NOT NULL,confirmation TEXT,confirmed_at INTEGER,PRIMARY KEY(bootstrap,step));`);
 const busy=new Set(),get=id=>store.db.prepare('SELECT * FROM meta_marketing_agency_bootstraps WHERE id=?').get(id);
 function record(flowId,reason,result='accepted'){
  const flow=store.db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(flowId),principal=flow&&policy.principals.find(p=>p.id===flow.principal);
  if(!flow||!principal?.enabled||store.backlog().pending>=policy.maxBacklog)fail('audit_unavailable');
  store.appendAudit(eventFor({requestId:flowId,operation:B.OPERATIONS.finish,tenantRef:flow.tenant,connectionRef:flow.connection,assetRef:flow.asset},principal,policy,result==='accepted'?'integration.requested':'integration.completed',result,reason,now()));
 }
 async function run({binding,flowId,adminSubjectId,signal,authorize,call},work){
  const b=A.bindingFor(binding),c=b.businessLogin,p=c.bootstrap,id=p.id,name=`Clinicaclick Marketing ${id}`;
  if(!C.uuid(flowId)||!M.graphId(adminSubjectId)||typeof authorize!=='function'||typeof call!=='function'||busy.has(id))fail('oauth_flow_busy');
  busy.add(id);const check=()=>{authorize();if(signal.aborted)fail('provider_timeout');};
  const digest=C.hash(JSON.stringify([b.appId,c.issuerBusinessId,c.configId,c.graphVersion,id,p.role,p.assets]));
  async function list(operation,params={}){let after=null,total=0,out=[];const cursors=new Set();do{check();const v=await call(operation,{...params,after});
    if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).some(k=>!['data','paging'].includes(k))||!Array.isArray(v.data)||v.data.length>100||(total+=v.data.length)>500)fail('provider_failed');out.push(...v.data);after=null;
    if(v.paging!==undefined){const q=v.paging;if(!q||Object.getPrototypeOf(q)!==Object.prototype||Object.keys(q).some(k=>!['cursors','next','previous'].includes(k)))fail('provider_failed');if(q.next!==undefined){if(typeof q.next!=='string'||!q.next||!q.cursors||typeof q.cursors.after!=='string'||!/^[A-Za-z0-9_+/=-]{1,2048}$/.test(q.cursors.after)||cursors.has(q.cursors.after))fail('provider_failed');after=q.cursors.after;cursors.add(after);}}
   }while(after);check();return out;}
  function step(name){return store.db.prepare('SELECT * FROM meta_marketing_agency_bootstrap_steps WHERE bootstrap=? AND step=?').get(id,name);}
  function intent(name){store.transaction(()=>{check();if(step(name))fail('outcome_unknown');record(flowId,'meta_agency_bootstrap_step_requested');store.db.prepare("INSERT INTO meta_marketing_agency_bootstrap_steps VALUES (?,?,?,NULL,'pending',NULL,NULL)").run(id,name,now());});}
  function ack(name,proof='provider_ack'){store.transaction(()=>{check();record(flowId,'meta_agency_bootstrap_step_confirmed','success');store.db.prepare("UPDATE meta_marketing_agency_bootstrap_steps SET ack_at=?,state='confirmed',confirmation=?,confirmed_at=? WHERE bootstrap=? AND step=?").run(proof==='provider_ack'?now():null,proof,now(),id,name);});}
  try{
   const memberships=await list('adminBusinesses');if(memberships.some(v=>!C.exact(v,'id,role,business')||!M.graphId(v.id)||typeof v.role!=='string'||!C.exact(v.business,'id')||!M.graphId(v.business.id))||memberships.filter(v=>v.business.id===c.issuerBusinessId&&v.role==='ADMIN').length!==1)fail('scope_denied');
   const apps=await list('ownedApps');if(apps.some(v=>!C.exact(v,'id')||!M.graphId(v.id))||apps.filter(v=>v.id===b.appId).length!==1)fail('scope_denied');
   const prior=get(id),available=new Set();if(!prior?.system_user)for(const [operation,kind]of [['ownedAds','ad_account'],['clientAds','ad_account'],['ownedPages','facebook_page'],['clientPages','facebook_page']]){
    const rows=await list(operation);for(const v of rows){if(!C.exact(v,'id')||typeof v.id!=='string')fail('provider_failed');const assetId=kind==='ad_account'?v.id.replace(/^act_/,''):v.id;if(!M.graphId(assetId))fail('provider_failed');available.add(`meta-${kind}:${assetId}`);}}
   if(!prior?.system_user&&p.assets.some(a=>!available.has(a.assetRef))||!b.credentialAssetRefs||JSON.stringify([...b.credentialAssetRefs].sort())!==JSON.stringify(p.assets.map(a=>a.assetRef).sort()))fail('scope_denied');
   let row=get(id);if(row&&(row.config_digest!==digest||row.business!==c.issuerBusinessId||row.app!==b.appId||row.name!==name))fail('scope_denied');
   const users=await list('systemUsers');if(users.some(v=>!C.exact(v,'id,name,role')||!M.graphId(v.id)||typeof v.name!=='string'||v.name.length>256||/[\u0000-\u001f\u007f]/.test(v.name)||!['ADMIN','EMPLOYEE'].includes(v.role))||new Set(users.map(v=>v.id)).size!==users.length)fail('provider_failed');
   const ours=users.filter(v=>v.name===name);if(ours.length>1||ours.some(v=>v.role!=='EMPLOYEE'))fail('scope_denied');
   if(!row){if(ours.length)fail('scope_denied');store.transaction(()=>{check();record(flowId,'meta_agency_bootstrap_requested');store.db.prepare("INSERT INTO meta_marketing_agency_bootstraps VALUES (?,?,?,?,?,?,NULL,'prepared',NULL,?,?)").run(id,digest,c.issuerBusinessId,b.appId,name,JSON.stringify(users),now(),now());});row=get(id);}
   if(row.system_user){if(ours.length!==1||ours[0].id!==row.system_user)fail('scope_denied');}
   else if(row.create_intent_at!==null){if(ours.length!==1)fail('outcome_unknown');if(JSON.parse(row.baseline_users).some(v=>v.id===ours[0].id))fail('scope_denied');store.transaction(()=>{check();record(flowId,'meta_agency_bootstrap_created','success');store.db.prepare("UPDATE meta_marketing_agency_bootstraps SET system_user=?,state='created',updated_at=? WHERE id=? AND system_user IS NULL").run(ours[0].id,now(),id);});row=get(id);}
   else{
    // This Root-reviewed first-allocation proof is never a recurring token
    // expiry requirement: recovery of our existing SU skips allocation/TTL.
    if(p.eligibilityExpiresAt<=now()||users.filter(v=>v.role==='EMPLOYEE').length>=p.regularLimit||ours.length)fail('operation_denied');
    store.transaction(()=>{check();record(flowId,'meta_agency_bootstrap_create_requested');store.db.prepare("UPDATE meta_marketing_agency_bootstraps SET create_intent_at=?,state='creating',updated_at=? WHERE id=? AND create_intent_at IS NULL").run(now(),now(),id);});
    const created=await call('create',{name});if(!C.exact(created,'id')||!M.graphId(created.id)||users.some(v=>v.id===created.id))fail('provider_failed');
    store.transaction(()=>{check();record(flowId,'meta_agency_bootstrap_created','success');store.db.prepare("UPDATE meta_marketing_agency_bootstraps SET system_user=?,state='created',updated_at=? WHERE id=?").run(created.id,now(),id);});row=get(id);
   }
   if(!M.graphId(row.system_user)||JSON.parse(row.baseline_users).some(v=>v.id===row.system_user))fail('scope_denied');
   const installed=step('install');if(!installed){intent('install');const v=await call('install',{id:row.system_user});if(v!==true&&(!C.exact(v,'success')||v.success!==true))fail('provider_failed');ack('install');}else if(!['confirmed','pending'].includes(installed.state))fail('outcome_unknown');
   for(const asset of p.assets){const match=/^meta-(ad_account|facebook_page):([1-9][0-9]*)$/.exec(asset.assetRef),isAd=match[1]==='ad_account',target=match[2],name='assign:'+asset.assetRef;
    const assigned=await list(isAd?'adUsers':'pageUsers',{id:target});if(assigned.some(v=>!C.exact(v,'id,tasks')||!M.graphId(v.id)||!Array.isArray(v.tasks)||v.tasks.some(t=>typeof t!=='string')||new Set(v.tasks).size!==v.tasks.length))fail('provider_failed');const matches=assigned.filter(v=>v.id===row.system_user);if(matches.length>1)fail('provider_failed');
    if(matches.length===1){if(JSON.stringify([...matches[0].tasks].sort())!==JSON.stringify([...asset.tasks].sort()))fail('scope_denied');if(step(name)?.state==='pending')ack(name);continue;}
    if(step(name))fail('outcome_unknown');intent(name);const v=await call(isAd?'assignAd':'assignPage',{id:target,name:row.system_user,tasks:asset.tasks});if(!C.exact(v,'success')||v.success!==true)fail('provider_failed');
    const observed=await list(isAd?'adUsers':'pageUsers',{id:target});if(observed.filter(v=>C.exact(v,'id,tasks')&&v.id===row.system_user&&Array.isArray(v.tasks)&&JSON.stringify([...v.tasks].sort())===JSON.stringify([...asset.tasks].sort())).length!==1)fail('scope_denied');ack(name);
   }
   const actualAssets=[];for(const [operation,kind]of [['systemAssignedAds','ad_account'],['systemAssignedPages','facebook_page']])for(const v of await list(operation,{id:row.system_user})){if(!C.exact(v,'id')||typeof v.id!=='string')fail('provider_failed');const target=kind==='ad_account'?v.id.replace(/^act_/,''):v.id;if(!M.graphId(target))fail('provider_failed');actualAssets.push(`meta-${kind}:${target}`);}if(new Set(actualAssets).size!==actualAssets.length||JSON.stringify(actualAssets.sort())!==JSON.stringify(p.assets.map(a=>a.assetRef).sort()))fail('scope_denied');
   const mint='mint:'+flowId;if(step(mint))fail('outcome_unknown');intent(mint);let token,result;
   try{result=await call('mint',{id:row.system_user});if(!C.exact(result,'access_token')||!tokenText(result.access_token))fail('oauth_credentials_incomplete');token=Buffer.from(result.access_token);delete result.access_token;
    const value=await work(token,row.system_user);if(installed?.state==='pending')ack('install','confirmed_by_validated_token');ack(mint);store.transaction(()=>{check();store.db.prepare("UPDATE meta_marketing_agency_bootstraps SET state='ready',updated_at=? WHERE id=?").run(now(),id);});return value;
   }finally{token?.fill(0);if(result)delete result.access_token;}
  }catch(error){try{store.transaction(()=>record(flowId,'meta_agency_bootstrap_unconfirmed','unknown'));}catch{}throw require('./meta-marketing-graph-pacing').safeError(error,'internal_error');}
  finally{busy.delete(id);}
 }
 return {run};
}
module.exports={createAgencyBootstrap};
