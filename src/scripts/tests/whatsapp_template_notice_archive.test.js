'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {archiveReviewedNotices}=require('../../lib/whatsappTemplateNoticeArchive');
const receipts=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
test('only the frozen administrative manifest is archived; never fake reconciliation or a clinical ACK',async()=>{
 const queries=[];const result=await archiveReviewedNotices({receipts,reason:'historical_cleanup_20261003',query:async(sql,params)=>{
  queries.push({sql,params});return sql.startsWith('SELECT')?receipts.map(receipt=>({receipt,archived_at:null,reconciled_at:null})): {affectedRows:2};
 }});
 assert.equal(result.archived,2);assert.equal(result.reconciled,false);assert.equal(result.clinicalReceiptsChanged,false);
 assert.match(queries[0].sql,/FOR UPDATE/);assert.doesNotMatch(queries[1].sql,/SET reconciled_at|WhatsappInboxImports|Messages|DELETE/);
 assert.deepEqual(queries[1].params,['historical_cleanup_20261003',...receipts]);
});
test('a reconciled, missing or already archived notice aborts the operation',async()=>{
 let updates=0;await assert.rejects(archiveReviewedNotices({receipts,reason:'historical_cleanup_20261003',query:async sql=>{
  if(sql.startsWith('UPDATE'))updates++;return [{receipt:receipts[0],reconciled_at:new Date()}];
 }}),/manifest_changed/);assert.equal(updates,0);
});
test('invalid or duplicated manifests cannot cause an unbounded update',async()=>{
 for(const input of [[],[receipts[0],receipts[0]],['private input']])await assert.rejects(archiveReviewedNotices({
  receipts:input,reason:'historical_cleanup_20261003',query:()=>{throw Error('unexpected query');}}),/manifest_invalid/);
});
