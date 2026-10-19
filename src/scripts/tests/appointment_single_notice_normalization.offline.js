'use strict';
require('./fixtures/security_offline_runtime.cjs');process.env.DB_HOST='127.0.0.1';
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const {hash,preservedNodes}=require('../../lib/appointment-single-notice-publication');
const filename=require.resolve('../../controllers/automationsV2.controller');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(fs.readFileSync(filename,'utf8')+'\nexports.__qaNormalize=normalizeNodesInput;exports.__qaGraph=validateFlowGraph;',filename);
const plan=JSON.parse(fs.readFileSync(process.env.SINGLE_NOTICE_PLAN,'utf8'));
const result={families:plan.entries.length,preserved_exact:0,ordinary_normalization_changes:0,graph_errors:[],ai_or_decision_changed:[]};
for(const entry of plan.entries){
 const normalized=preservedNodes(entry.source,entry.body);
 assert.equal(hash(normalized),hash(entry.body.nodes));result.preserved_exact++;
 if(hash(m.exports.__qaNormalize(entry.body.nodes))!==hash(entry.body.nodes))result.ordinary_normalization_changes++;
 for(const node of entry.source.nodes.filter(n=>['condition/ai_analysis','condition/field_check'].includes(n.type))){
   const candidate=normalized.find(n=>n.id===node.id);
   if(hash({config:candidate?.config,outputs:candidate?.outputs})!==hash({config:node.config,outputs:node.outputs}))result.ai_or_decision_changed.push({family:entry.source.public_id,node:node.id});
 }
 const checked=m.exports.__qaGraph({entry_node_id:entry.body.entry_node_id,nodes:normalized});
 if(!checked.ok)result.graph_errors.push({family:entry.source.public_id,errors:checked.errors});
}
console.log(JSON.stringify(result));
Promise.resolve().then(async()=>{
 const q=require('../../services/queue.service');for(const queue of Object.values(q.queues))await queue.close();
 if(q.connection?.connection?.quit)await q.connection.connection.quit();await require('../../../models').sequelize.close();
 assert.deepEqual(result.graph_errors,[]);assert.deepEqual(result.ai_or_decision_changed,[]);
}).catch(error=>{console.error(error.message);process.exitCode=1;});
