'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createReportReadCache}=require('../../lib/report-read-cache');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('identical pending reads share one computation; scopes and cache capacity remain separate',async()=>{
 let at=0,calls=0,resolve;const cache=createReportReadCache({now:()=>at,freshMs:10,staleMs:50,maxEntries:2});
 const load=()=>{calls++;return new Promise(r=>resolve=r)};
 const a=cache.read('clinic:1',load),b=cache.read('clinic:1',load);await tick();assert.equal(calls,1);resolve({count:7});assert.equal((await a).value.count,7);assert.equal((await b).value.count,7);
 assert.equal((await cache.read('clinic:1',()=>{throw Error('duplicate')})).status,'hit');
 await cache.read('clinic:2',()=>({count:2}));await cache.read('group:2',()=>({count:9}));assert.equal(cache.size(),2);
});
test('expired aggregate serves its dated snapshot while exactly one refresh runs; errors do not poison subsequent reads',async()=>{
 let at=0,calls=0,resolve;const cache=createReportReadCache({now:()=>at,freshMs:10,staleMs:50});
 await cache.read('a',()=>({count:1}));at=11;const load=()=>{calls++;return new Promise(r=>resolve=r)};
 const first=await cache.read('a',load),second=await cache.read('a',load);assert.equal(first.status,'refreshing');assert.equal(second.value.count,1);await tick();assert.equal(calls,1);
 resolve({count:2});await tick();assert.equal((await cache.read('a',load)).value.count,2);
 at=70;await assert.rejects(cache.read('a',()=>Promise.reject(Error('offline'))));
 assert.equal((await cache.read('a',()=>({count:3}))).value.count,3);
});
test('invalidating during a read prevents old work from reviving post-mutation cache state',async()=>{
 let release;const cache=createReportReadCache();const before=cache.read('a',()=>new Promise(r=>release=r));await tick();cache.clear();
 await cache.read('a',()=>({count:2}));release({count:1});await before;
 assert.equal((await cache.read('a',()=>{throw Error('must hit')})).value.count,2);
});
