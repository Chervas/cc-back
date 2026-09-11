'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Redis = require('ioredis');

(async () => {
  const key = `dev:qa:campaign-creative:${crypto.randomUUID()}`;
  const store = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500 });
  try {
    await store.connect();
    for (const action of ['write', 'read']) {
      const code = `const assert=require('node:assert/strict'); const log=console.log; console.log=()=>{};
        const {cachedCreative}=require('./src/services/campaignAdCreative.service'); console.log=log;
        const Redis=require('ioredis'); const store=new Redis(process.env.REDIS_URL||'redis://127.0.0.1:6379',{lazyConnect:true,maxRetriesPerRequest:0});
        (async()=>{ const result=await cachedCreative(process.env.QA_CREATIVE_KEY, async()=>{
          if(process.env.QA_CREATIVE_ACTION==='read') throw Error('cache missed across API processes');
          return {preview:{available:true,headlines:['Isolated test']},error:null}; },{store});
          assert.equal(result.preview.headlines[0],'Isolated test');
        })().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>store.disconnect());`;
      execFileSync(process.execPath, ['-e', code], { cwd: process.cwd(), env: { ...process.env, QA_CREATIVE_KEY: key, QA_CREATIVE_ACTION: action }, timeout: 10000 });
    }
    const ttl = await store.ttl(key); assert.ok(ttl > 86300 && ttl <= 86400);
    console.log('Creative cache: retained across two processes, TTL 24h, no provider calls or customer rows.');
  } finally { await store.del(key); store.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
