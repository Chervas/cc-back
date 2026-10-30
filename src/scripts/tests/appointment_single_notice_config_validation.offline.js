#!/usr/bin/env node
'use strict';

// Definitions are collected separately in a read-only operator transaction.
// This phase cannot connect to SQL, Redis, providers or application workers.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
require('./fixtures/security_offline_runtime.cjs');process.env.DB_HOST='127.0.0.1';
const {hash,preservedNodes,validatePreservedNodeConfigs}=require(process.env.APPOINTMENT_ACK_REVIEW_QA==='1'
  ? '../../lib/day-before-acknowledgement-publication' : process.env.APPOINTMENT_MESSAGE_COPY_QA==='1'
  ? '../../lib/appointment-copy-publication' : '../../lib/appointment-single-notice-publication');
const files=['SINGLE_NOTICE_PLAN','SINGLE_NOTICE_LOOKUP','SINGLE_NOTICE_VALIDATION_REPORT'];
for(const key of files)assert(process.env[key]?.startsWith('/home/ubuntu/secure-imports/'),'PRIVATE_VALIDATION_FILES_REQUIRED');
assert(!fs.existsSync(process.env.SINGLE_NOTICE_VALIDATION_REPORT),'NEW_VALIDATION_REPORT_REQUIRED');
const plan=JSON.parse(fs.readFileSync(process.env.SINGLE_NOTICE_PLAN));
const lookup=JSON.parse(fs.readFileSync(process.env.SINGLE_NOTICE_LOOKUP));
const log=console.log;console.log=()=>{};
let db,native;
try{
  db=require('../../../models');
  db.WhatsappTemplate.findAll=async()=>lookup.templates;
  db.WhatsappTemplateCatalog.findAll=async()=>lookup.catalogs;
  db.sequelize.query=async()=>{throw Error('CONFIG_VALIDATION_SQL_FORBIDDEN');};
  for(const model of Object.values(db))if(model?.rawAttributes){
    for(const hook of ['beforeCreate','beforeUpdate','beforeDestroy','beforeBulkCreate','beforeBulkUpdate','beforeBulkDestroy']){
      model.addHook(hook,()=>{throw Error('CONFIG_VALIDATION_WRITE_FORBIDDEN');});
    }
  }
  const filename=require.resolve('../../controllers/automationsV2.controller');
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(filename,'utf8')+'\nexports.__qaConfig=validateNodeConfigs;exports.__qaGraph=validateFlowGraph;exports.__qaMap=mapTemplate;',filename);
  native=m.exports;
}finally{console.log=log;}

(async()=>{
  const report={at:new Date().toISOString(),readOnly:true,models:'offline',graphs:plan.entries.length,
    passed:0,unchangedGraphs:0,inheritedRequiredErrors:0,failed:[]};
  try{
    for(const entry of plan.entries){
      const originalHash=hash(entry.source),candidateHash=hash(entry.body.nodes);
      const nodes=preservedNodes(entry.source,entry.body),graph=native.__qaGraph(entry.body);
      const result=await validatePreservedNodeConfigs(entry.source,nodes,native.__qaConfig);
      for(const row of [entry.source,{...entry.source,...entry.body}]){
        const mapped=native.__qaMap(row,{access:{is_admin:true,user_id:1}});
        assert.equal(mapped.stored_graph_hash,hash({entry_node_id:row.entry_node_id,trigger_type:row.trigger_type,nodes:row.nodes}),
          'DTO_FINGERPRINT_MUST_IDENTIFY_STORED_GRAPH');
      }
      assert.equal(hash(entry.source),originalHash,'CONFIG_VALIDATION_CHANGED_SOURCE');
      assert.equal(hash(nodes),candidateHash,'CONFIG_VALIDATION_CHANGED_CANDIDATE');
      report.unchangedGraphs++;
      report.inheritedRequiredErrors+=result.inherited_required_errors||0;
      if(graph.ok&&result.ok)report.passed++;
      else report.failed.push({sourceId:entry.source.id,clinicId:entry.source.clinic_id,
        errors:[...(graph.errors||[]),...(result.errors||[])]});
    }
    fs.writeFileSync(process.env.SINGLE_NOTICE_VALIDATION_REPORT,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({...report,failed:report.failed.length}));
    assert.equal(report.failed.length,0,'EXACT_NODE_CONFIGURATION_VALIDATION_FAILED');
  }finally{
    for(const queue of Object.values(require('../../services/queue.service').queues))await queue.close();
    await db.sequelize.close();
  }
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
