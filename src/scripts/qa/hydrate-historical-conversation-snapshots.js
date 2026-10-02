'use strict';

const fs=require('node:fs');
const args=process.argv.slice(2);
const argument=key=>args[args.indexOf(key)+1];
const root='/home/ubuntu/wt/back-staging';
const parse=v=>typeof v==='string'?JSON.parse(v):v;

async function main() {
  const data=JSON.parse(fs.readFileSync(argument('--cases')));
  const {env}=require(root+'/src/scripts/security-email-login-metadata').observedEnvironment('staging');
  const c=await require(root+'/node_modules/mysql2/promise').createConnection(
    require(root+'/src/scripts/security-database-metadata').configuration(env));
  try {
    await c.query('START TRANSACTION READ ONLY');
    const ids=[...new Set(data.cases.map(c=>c.execution_id))];
    const [rows]=await c.query(`SELECT id,context FROM FlowExecutionsV2 WHERE id IN (${ids.map(()=>'?').join(',')})`,ids);
    const contexts=new Map(rows.map(r=>[r.id,parse(r.context)]));
    let replaced=0,participantBindingsDifferent=0;
    for(const item of data.cases) {
      const snapshot=contexts.get(item.execution_id)?.conversation;
      const current=item.context.conversation;
      if(!snapshot || Number(snapshot.id)!==Number(current.id) || Number(snapshot.clinic_id)!==Number(item.clinic_id)) {
        throw Error('scoped_historical_conversation_snapshot_missing:'+item.id);
      }
      if(Number(snapshot.patient_id)!==Number(current.patient_id) || Number(snapshot.lead_id)!==Number(current.lead_id)) participantBindingsDifferent++;
      item.context.conversation=snapshot;
      item.conversationContextEvidence={source:'persisted_execution_conversation_snapshot',originalAiInputSnapshotAvailable:false};
      replaced++;
    }
    data.conversationContextReconstruction={replaced,participantBindingsDifferent,
      limitation:'Persisted execution snapshot, not an original complete AI input snapshot.'};
    fs.writeFileSync(argument('--report'),JSON.stringify(data),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({cases:data.cases.length,replaced,participantBindingsDifferent}));
  }finally{await c.rollback();await c.end();}
}
main().catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1});
