#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {scoped}=require('../lib/appointment-single-notice-flow');
const {planEntry}=require('../lib/appointment-single-notice-publication');
async function main(){
  const [target,output,...extra]=process.argv.slice(2);
  if(!['dev','crm'].includes(target)||!path.isAbsolute(output||'')||extra.length)throw Error('Usage: appointment-single-notice-plan.js dev|crm /private/absolute/new-plan.json (READ ONLY)');
  const parent=fs.statSync(path.dirname(output));
  if((parent.mode&0o077)!==0)throw Error('Plan directory must be private (0700)');
  const connection=await connectOperatorDatabase(target);
  try{
    await connection.query('START TRANSACTION READ ONLY');
    const [rows]=await connection.query('SELECT id,public_id,template_key,version,name,description,trigger_type,trigger_config,is_active,is_system,clinic_id,group_id,entry_node_id,nodes,published_at FROM AutomationFlowTemplatesV2 WHERE published_at IS NOT NULL ORDER BY version DESC,id DESC');
    const latest=new Map();for(const row of rows){const key=JSON.stringify([row.public_id,row.clinic_id,row.group_id]);if(!latest.has(key))latest.set(key,row);}
    const plan={version:1,target,read_only:true,generated_at:new Date().toISOString(),entries:[],review:[],already_updated:0};
    for(const row of latest.values()){
      if(!scoped(row))continue;
      for(const key of ['nodes','trigger_config'])if(typeof row[key]==='string')row[key]=JSON.parse(row[key]);
      row.is_active=!!row.is_active;row.is_system=!!row.is_system;
      try{const entry=planEntry(row);if(entry)plan.entries.push(entry);else plan.already_updated++;}
      catch(error){plan.review.push({public_id:row.public_id,version:row.version,clinic_id:row.clinic_id,reason:error.message});}
    }
    await connection.rollback();fs.writeFileSync(output,JSON.stringify(plan,null,2),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({read_only:true,target,entries:plan.entries.length,review:plan.review.length,already_updated:plan.already_updated,output}));
  }finally{await connection.rollback().catch(()=>{});await connection.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
