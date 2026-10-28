'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { verifySearchConsoleArchive, stageSearchConsoleArchive } = require('../../lib/searchConsoleArchiveVerifier');
const sha = value => createHash('sha256').update(value).digest('hex');
const fields = ['date','query_id','page_id','query','page_url','clicks','impressions','position_weighted','position_sum','position_count','row_digest'];
function factory({ days = 1, queries = 300, textBytes = 10 } = {}) {
  const header = { version: 1, siteUrl: 'sc-domain:stream-fixture.example', startDate: '2024-01-01', endDate: '2024-01-31', revision: '1' };
  const texts = Array.from({ length: queries }, (_, i) => 'query-' + (i + 1) + '-' + 'x'.repeat(textBytes));
  function* rows() {
    for (let day = 1; day <= days; day++) for (let i = 1; i <= queries; i++) {
      const row = { date: '2024-01-' + String(day).padStart(2,'0'), query_id: String(i), page_id: '1', query: texts[i-1], page_url: '',
        clicks: '1', impressions: '1', position_weighted: '1.000000000', position_sum: '1.000000000', position_count: '1' };
      row.row_digest = sha(JSON.stringify([row.date, sha(row.query), sha(''), row.clicks, row.impressions, row.position_weighted, row.position_sum, row.position_count]));
      yield row;
    }
  }
  const expectedHash = createHash('sha256'), recordsHash = createHash('sha256'); let bytes = 0;
  const begin = Buffer.from(JSON.stringify(header) + '\n'); expectedHash.update(begin); bytes += begin.length;
  for (const row of rows()) { const line = Buffer.from(JSON.stringify(row) + '\n'); expectedHash.update(line); bytes += line.length; recordsHash.update(JSON.stringify(fields.map(k=>row[k])) + '\n'); }
  const expected = { siteUrl: header.siteUrl, month: '2024-01', sha256: expectedHash.digest('hex'), bytes, rows: days * queries };
  const expectedRecords = recordsHash.digest('hex');
  async function* open(corruptLast = false) {
    let chunks = [begin], size = begin.length, index = 0;
    for (const row of rows()) {
      index++; if(corruptLast && index === expected.rows) row.clicks = '2';
      const line = Buffer.from(JSON.stringify(row) + '\n'); chunks.push(line); size += line.length;
      if(size >= 64000) { yield Buffer.concat(chunks); chunks=[];size=0; }
    }
    if(size) yield Buffer.concat(chunks);
  }
  return { expected, expectedRecords, open };
}

test('same parser verifies first and stages only bounded awaited provisional batches on second pass', async()=>{
  const f=factory(), first=await verifySearchConsoleArchive(f.open(),f.expected);
  let total=0, largest=0, active=0, peak=0;
  const rowsHash=createHash('sha256');
  const second=await stageSearchConsoleArchive(f.open(),f.expected,{onStagedRows:async rows=>{
    active++;peak=Math.max(peak,active);largest=Math.max(largest,rows.length);
    assert(Object.isFrozen(rows));for(const row of rows){assert(Object.isFrozen(row));rowsHash.update(JSON.stringify(fields.map(k=>row[k]))+'\n');}
    await Promise.resolve();total+=rows.length;active--;
  }});
  assert.equal(total,300);assert.equal(largest,250);assert.equal(peak,1);
  assert.equal(first.recordsSha256,f.expectedRecords);assert.equal(second.recordsSha256,first.recordsSha256);
  assert.equal(rowsHash.digest('hex'),first.recordsSha256);assert.equal(Object.hasOwn(first,'records'),false);
});
test('late malformed/corrupt source never produces a verified final result, even after provisional batches',async()=>{
  const f=factory();let staged=0,returned=false;
  await assert.rejects((async()=>{await stageSearchConsoleArchive(f.open(true),f.expected,{onStagedRows:async rows=>{staged+=rows.length;}});returned=true;})(),e=>/^sc_archive_/.test(e.code));
  assert.equal(staged,250);assert.equal(returned,false);
});
test('dictionary limits bound retained ID/hash state and collect-all cannot opt into GiB limits',async()=>{
  const f=factory();
  await assert.rejects(verifySearchConsoleArchive(f.open(),f.expected,{limits:{maxDictionaryBindings:10}}),{code:'sc_archive_dictionary_bound'});
  await assert.rejects(verifySearchConsoleArchive(f.open(),f.expected,{collectRecords:true,limits:{maxBytes:1024**3}}),{code:'sc_archive_collect_bound'});
});
test('dense synthetic month larger than 256MiB verifies and stages without collecting it', {timeout:120000},async()=>{
  const f=factory({days:22,queries:10000,textBytes:1000});assert(f.expected.bytes>256*1024*1024);
  const limits={maxBytes:1024**3,maxRows:1000000,maxDictionaryBindings:100000};
  const first=await verifySearchConsoleArchive(f.open(),f.expected,{limits});
  let rows=0,batches=0,largest=0;
  const second=await stageSearchConsoleArchive(f.open(),f.expected,{limits,onStagedRows:async batch=>{rows+=batch.length;batches++;largest=Math.max(largest,batch.length);}});
  assert.equal(rows,220000);assert.equal(batches,880);assert.equal(largest,250);
  assert.equal(first.recordsSha256,f.expectedRecords);assert.equal(second.recordsSha256,f.expectedRecords);
  assert.equal(Object.hasOwn(first,'records'),false);assert.equal(Object.hasOwn(second,'records'),false);
});
