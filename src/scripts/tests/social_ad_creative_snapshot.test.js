'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../../../services/integrations-broker/src/meta-marketing-ads-creative');
const {validSharing,socialAdCreativeSnapshot}=require('../../lib/social-ad-creative-snapshot');
const image='https://scontent.fbcdn.net/original.jpg';
const ad=sharing=>({id:'700',campaign_id:'401',adset_id:'402',creative:{id:'801',sharing}});

test('snapshot writer keeps v1 compatibility and creates an explicit missing-source envelope for requested v2',()=>{
  const sharing=C.project({id:'801',body:'Original copy',image_url:image});
  const legacy=socialAdCreativeSnapshot({accountId:'act_301',ad:ad(sharing)});
  assert.equal(legacy.version,1);assert.equal(legacy.creative.version,1);assert(validSharing(sharing));
  for(const version of [1,2]){
    const empty=socialAdCreativeSnapshot({accountId:'301',ad:{id:'700',campaign_id:'401',adset_id:'402'},creativeVersion:version});
    assert.equal(empty.version,version);assert.equal(empty.creative.version,version);assert(validSharing(empty.creative));
    assert.equal(empty.creative.source_issue,'creative_not_synchronized');
    if(version===2)assert.deepEqual([empty.creative.copies,empty.creative.alternatives],[[],[]]);
  }
});

test('v2 snapshot persists factored complete alternatives, pins exact identity and does not mutate raw ad',()=>{
  const sharing=C.project({id:'801',body:'Source common copy',asset_feed_spec:{images:[{url:image},{hash:'a'.repeat(32)}]}},2);
  const original=ad(sharing),before=structuredClone(original);
  const snapshot=socialAdCreativeSnapshot({accountId:'301',ad:original,creativeVersion:2,now:new Date('2026-11-18T13:00:00Z')});
  assert.equal(snapshot.version,2);assert.equal(snapshot.creative.version,2);assert.equal(snapshot.creative.copies.length,1);
  assert.equal(snapshot.creative.alternatives.length,2);assert.deepEqual(snapshot.reference,{provider:'meta_ads',account_id:'301',campaign_id:'401',group_id:'402',ad_id:'700'});
  snapshot.creative.copies[0].body='changed owned clone';assert.deepEqual(original,before);
});

test('snapshot writer never silently downgrades the negotiated version or accepts invalid option/copy linkage',()=>{
  const one=C.project({body:'copy',image_url:image}),two=C.project({body:'copy',asset_feed_spec:{images:[{url:image},{url:image+'?v=2'}]}},2);
  for(const [sharing,version]of [[one,2],[two,1]])assert.throws(()=>socialAdCreativeSnapshot({accountId:'301',ad:ad(sharing),creativeVersion:version}),{code:'invalid_social_ad_creative_projection'});
  const invalid=structuredClone(two);invalid.alternatives[0].copy_id='f'.repeat(64);assert.equal(validSharing(invalid),false);
  assert.throws(()=>socialAdCreativeSnapshot({accountId:'301',ad:ad(invalid),creativeVersion:2}),{code:'invalid_social_ad_creative_projection'});
  for(const creativeVersion of [0,3,'2'])assert.throws(()=>socialAdCreativeSnapshot({accountId:'301',ad:ad(two),creativeVersion}),{code:'invalid_social_ad_creative_identity'});
});
