#!/usr/bin/env node
'use strict';
// Dedicated staging importer: does not load application models, queues,
// automation handlers, patient matching or any provider client.
const {createInboxClient,clientFiles}=require('../lib/whatsappInboxClient');
const {importLease}=require('../lib/whatsappInboxImport');
const scoped=require('../lib/whatsappInboxScopes');
const health=require('../lib/whatsappInboxHealth');
async function main(env=process.env) {
  const scopes=scoped.configuration(env);
  if(env.RUNTIME_NAMESPACE!=='staging' || env.WHATSAPP_INBOX_CONSUMER_ENABLED!=='true'
    || (!scopes && (env.WHATSAPP_INBOX_CLINIC_ID!=='19' || env.WHATSAPP_INBOX_WABA_ID!=='1024525056749708'
      || env.WHATSAPP_INBOX_PHONE_ID!=='1272578249265908')) || env.DB_NAME!=='clinicaclick') throw Error('inbox_consumer_configuration_invalid');
  const client=createInboxClient(clientFiles(env,'staging')); const mysql=require('mysql2/promise');
  const scope={clinicId:19,wabaId:env.WHATSAPP_INBOX_WABA_ID,phoneId:env.WHATSAPP_INBOX_PHONE_ID};
  const recoveryNotBefore=env.WHATSAPP_INBOX_RECOVERY_NOT_BEFORE || null;
  if(recoveryNotBefore && !Number.isFinite(Date.parse(recoveryNotBefore)))throw Error('inbox_recovery_cutoff_invalid');
  let stopping=false;let timer;let active;let connection;
  const stop=()=>{stopping=true;clearTimeout(timer);active?.();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    connection=await mysql.createConnection({host:env.DB_HOST,user:env.DB_USERNAME,password:env.DB_PASSWORD,database:env.DB_NAME,connectTimeout:3000,timezone:'Z'});
    // A dedicated connection lock prevents a second runtime from importing.
    const [[owner]]=await connection.execute("SELECT GET_LOCK('cc-whatsapp-inbox-staging-v1',0) acquired");
    if(owner.acquired!==1)throw Error('inbox_consumer_owner_exists');
    for(const table of ['WhatsappInboxImports','WhatsappInboxMessageKeys','WhatsappInboxContactKeys']) await connection.query('SELECT 1 FROM '+table+' LIMIT 0');
    while(!stopping){
      try{
        const listed=await client.request('GET','/pending');
        if(listed.status!==200 || listed.data?.automaticActionsAllowed!==false || !Array.isArray(listed.data.receipts) || listed.data.receipts.length>20)throw Error();
        health.publish(listed.data.health,scopes?.scopes || [{...scope,clinicIds:[scope.clinicId]}],{
          recoveryNotBefore,recoveryHold:env.WHATSAPP_INBOX_RECOVERY_HOLD==='true'});
        for(const item of listed.data.receipts){
          if(stopping)break;let raw;let lease;
          try{
            const result=await client.request('POST','/lease',{receipt:item.receipt});
            if(result.status!==200)continue;lease=result.data;
            if(lease.receipt!==item.receipt || typeof lease.rawBase64!=='string' || lease.rawBase64.length>4*1024*1024)throw Error();
            raw=Buffer.from(lease.rawBase64,'base64');delete lease.rawBase64;
            lease.recoveryWithoutAutomation=env.WHATSAPP_INBOX_RECOVERY_HOLD==='true'
              || !Number.isFinite(lease.receivedAt) || lease.receivedAt < Date.now()-120000
              || !!recoveryNotBefore && lease.receivedAt < Date.parse(recoveryNotBefore);
            const imported=scopes
              ? await scoped.importScopedLease(connection,{...lease,raw},scopes,{loadConfiguration:()=>scoped.configuration(env)})
              : await importLease(connection,{...lease,raw},scope);
            const ack=await client.request('POST','/confirm',{receipt:lease.receipt,lease:lease.lease,importReceipt:imported.importReceipt});
            if(ack.status!==200 || ack.data?.businessProcessed!==true)throw Error();
          }catch(error){
            const reason=['unsupported_event','unmatched_status','review_required','import_retry'].includes(error.inboxReason)?error.inboxReason:'import_retry';
            if(lease?.lease)await client.request('POST','/defer',{receipt:lease.receipt,lease:lease.lease,reason}).catch(()=>{});
            process.stderr.write(JSON.stringify({event:'whatsapp_inbox_item_deferred',reason})+'\n');
          }
          finally{raw?.fill(0);}
        }
      }catch{process.stderr.write('WHATSAPP_INBOX_POLL_UNAVAILABLE\n');}
      if(!stopping)await new Promise(resolve=>{timer=setTimeout(resolve,5000);active=resolve;});
    }
  }finally{client.close();await connection?.end().catch(()=>{});}
}
if(require.main===module)main().catch(()=>{process.stderr.write('WHATSAPP_INBOX_CONSUMER_STOPPED\n');process.exitCode=1;});
module.exports={main};
