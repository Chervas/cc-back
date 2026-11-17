'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(require.resolve('../../routes/marketing.routes'),'utf8');
const from=source.indexOf('router.use((req,res,next)=>{'),to=source.indexOf('\nconst limitWebSaves',from);
assert(from>0&&to>from);

test('native HTTP cache middleware preserves statistics after schedule edits and keeps other mutation invalidations',()=>{
 let middleware,invalidations=0,nextCalls=0;
 vm.runInNewContext(source.slice(from,to),{router:{use:fn=>middleware=fn},require:name=>{
  assert.equal(name,'../services/reviewOverview.service');return {invalidate(){invalidations++;}};
 }});
 const request=(method,path,statusCode=200)=>{const res=new EventEmitter();res.statusCode=statusCode;
  middleware({method,path},res,()=>nextCalls++);res.emit('finish');};
 request('PATCH','/bulk-sends/campaigns/1/review-schedule');
 request('PATCH','/bulk-sends/campaigns/1/review-schedule/');
 request('GET','/review-requests/queues');request('PUT','/review-requests/draft');
 request('POST','/bulk-sends/campaigns/1/test-send');
 assert.equal(invalidations,0);assert.equal(nextCalls,5);
 request('PATCH','/bulk-sends/campaigns/1/recipients/2');assert.equal(invalidations,1);
 request('POST','/bulk-sends/campaigns/1/prepare');assert.equal(invalidations,2);
 request('PATCH','/bulk-sends/campaigns/1/recipients/2',409);assert.equal(invalidations,2);
});
