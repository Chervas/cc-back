'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { forComments, preview } = require('../../services/socialCommentAd.service');
const { unmatchedAds } = require('../../services/socialCommentMonitoring.service');

test('a missing or dynamic ad ID does not trigger a lookup or imply a particular advertiser', async () => {
  const result = await forComments({},72,[{ metadata: { social: { ad: { title: 'Promotion' } } } }], new Date());
  assert.equal(result.size, 0);
});

test('one scoped database query per history page, with a Meta link for an unsynchronized ad', async () => {
  let reads = 0;
  const comments = ['188','188','199'].map(id=>({metadata:{social:{ad:{id}}}}));
  const db = { sequelize: { query: async (sql, {replacements}) => {
    reads++; assert.deepEqual(replacements, {ids:['188','199'], clinicId:72});
    return [[{entity_id:'188',ad_account_id:'act_22',name:'Bono de noviembre'}]];
  } } };
  const ads = await forComments(db,72,comments,new Date());
  assert.equal(reads,1);
  assert.equal(ads.get('188').name,'Bono de noviembre');
  assert.match(ads.get('188').url,/act=22&selected_ad_ids=188/);
  assert.deepEqual(ads.get('199'),{url:'https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=199'});
});

test('mismatching snapshot identity exposes no copy or media', () => {
  const row = { entity_id:'188', ad_account_id:'act_22',parent_id:'11',name:'Anuncio',
    creative_payload:{reference:{provider:'meta_ads',account_id:'45',ad_id:'188',group_id:'11'}} };
  const result = preview(row, new Date());
  assert.equal(result.headline, undefined);
  assert.equal(result.body, undefined);
  assert.equal(result.image, undefined);
});

test('monitor compares scoped individual receipts and never equates different ads or clinics',async () => {
  const scopes = new Map([[72,Date.parse('2026-11-25')],[73,Date.parse('2026-11-28')]]);
  const rows = [[{clinic:72,ad:'17',day:'2026-11-27',total:3},{clinic:72,ad:'18',day:'2026-11-27',total:1},
    {clinic:73,ad:'19',day:'2026-11-27',total:1}], [{clinic:72,ad:'17',total:2},{clinic:73,ad:'17',total:1},
    {clinic:72,ad:'18',total:1}]];
  const results = await unmatchedAds(async()=>rows.shift(),scopes,Date.parse('2026-11-28T12:00Z'));
  assert.deepEqual(results,[{clinic:72,ad:'17',total:1}]);
  assert.equal(rows.length,0);
});
