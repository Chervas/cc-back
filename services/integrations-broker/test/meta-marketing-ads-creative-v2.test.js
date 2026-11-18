'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../src/meta-marketing-ads-creative');
const A = require('../src/meta-marketing-ads-contract');
const IMAGE = 'https://scontent.fbcdn.net/original.jpg', SECOND = 'https://scontent.fbcdn.net/vertical.jpg';
const HASH = 'a'.repeat(32), OTHER_HASH = 'b'.repeat(32);
const common = (extra = {}) => ({id:'801',body:'Actual common copy',title:'Actual title',...extra});
const pair = () => C.project(common({asset_feed_spec:{images:[{url:IMAGE},{url:SECOND}]}}),2);

test('v2 preserves original media alternatives with one factored copy and no implicit default choice', () => {
  const value = pair(); C.validate(value,2);
  assert.equal(value.version,2); assert.equal(value.has_variants,true);
  assert.equal(value.source_issue,'creative_variants_require_selection'); assert.equal(value.image_url,null);
  assert.equal(value.body,''); assert.equal(value.title,''); assert.equal(value.copies.length,1);
  assert.equal(value.copies[0].body,'Actual common copy'); assert.equal(value.alternatives.length,2);
  assert.deepEqual(value.alternatives.map(v=>v.image_url),[IMAGE,SECOND]);
  assert(value.alternatives.every(v=>v.copy_id===value.copies[0].copy_id && !Object.hasOwn(v,'body')));
  assert.equal(new Set(value.alternatives.map(v=>v.variant_id)).size,2);
  assert.deepEqual(value,pair(),'variant IDs are deterministic');
});

test('a uniquely absent copy remains a valid factored empty copy, while multiple unpaired texts remain ambiguous',()=>{
  const value=C.project({id:'801',asset_feed_spec:{images:[{url:IMAGE},{url:SECOND}]}},2);
  C.validate(value,2);assert.equal(value.alternatives.length,2);assert.equal(value.copies.length,1);
  assert.equal(value.copies[0].body,'');assert.equal(value.copies[0].title,'');
  assert(value.alternatives.every(a=>a.copy_id===value.copies[0].copy_id));
  const unknown=C.project({id:'801',asset_feed_spec:{images:[{url:IMAGE},{url:SECOND}],bodies:[{adlabels:[{name:'missing-text'}]}]}},2);
  assert.equal(unknown.source_issue,'creative_copy_invalid');assert.equal(unknown.alternatives.length,0);
  const single=C.project({id:'801',image_url:IMAGE,asset_feed_spec:{bodies:[{adlabels:[{name:'missing-text'}]}]}},2);
  assert.equal(single.source_issue,'creative_copy_invalid');
  assert.equal(C.project({id:'801',image_url:IMAGE,asset_feed_spec:{ad_formats:[{}]}},2).source_issue,'creative_relationship_ambiguous');
});

test('labeled source rules preserve complete pairs rather than generating a text/image Cartesian product', () => {
  const value=C.project({id:'801',asset_feed_spec:{
    images:[{url:IMAGE,adlabels:[{name:'feed'}]},{url:SECOND,adlabels:[{name:'story'}]}],
    bodies:[{text:'Feed copy',adlabels:[{name:'copy-feed'}]},{text:'Story copy',adlabels:[{name:'copy-story'}]}],
    titles:[{text:'Common title'}],asset_customization_rules:[
      {image_label:{name:'feed'},body_label:{name:'copy-feed'}},
      {image_label:{name:'story'},body_label:{name:'copy-story'}},
    ]}},2);
  C.validate(value,2); assert.equal(value.alternatives.length,2);
  const expanded=value.alternatives.map(v=>[v.image_url,value.copies.find(c=>c.copy_id===v.copy_id).body]);
  assert.deepEqual(expanded,[[IMAGE,'Feed copy'],[SECOND,'Story copy']]);
  assert(value.alternatives.every(v=>v.provenance.path.startsWith('asset_customization_rules[')));
});

test('unpaired dynamic copy, unresolved labels and unbound rule assets stay explicitly ambiguous', () => {
  const inputs=[
    {asset_feed_spec:{images:[{url:IMAGE},{url:SECOND}],bodies:[{text:'A'},{text:'B'}]}},
    {asset_feed_spec:{images:[{url:IMAGE,adlabels:[{name:'feed'}]}],asset_customization_rules:[{image_label:{name:'absent'}}]}},
    {asset_feed_spec:{images:[{url:IMAGE,adlabels:[{name:'feed'}]},{url:SECOND}],asset_customization_rules:[{image_label:{name:'feed'}}]}},
    {asset_feed_spec:{images:[{url:IMAGE,adlabels:[{name:'same'}]},{url:SECOND,adlabels:[{name:'same'}]}],asset_customization_rules:[{image_label:{name:'same'}}]}},
    {asset_feed_spec:{images:[{url:IMAGE,adlabels:[{name:'feed'}]}],asset_customization_rules:[{image_label:{name:'feed'}}]},platform_customizations:{instagram:{image_url:SECOND}}},
  ];
  for(const input of inputs){const v=C.project(common(input),2);assert.equal(v.source_issue,'creative_relationship_ambiguous');assert.equal(v.alternatives.length,0);C.validate(v,2);}
});

test('explicit platform and story media/copy pairs remain coherent and carousel stays a distinct exclusion', () => {
  const value=C.project(common({image_url:IMAGE,platform_customizations:{instagram:{image_url:SECOND,body:'Instagram copy',title:'Instagram title'}}}),2);
  C.validate(value,2); assert.equal(value.alternatives.length,2);
  const option=value.alternatives.find(v=>v.image_url===SECOND);
  assert.equal(value.copies.find(c=>c.copy_id===option.copy_id).body,'Instagram copy');
  assert.deepEqual(option.provenance,{source:'platform_customizations',path:'instagram'});
  const carousel=C.project(common({object_story_spec:{link_data:{child_attachments:[{picture:IMAGE},{picture:SECOND}]}}}),2);
  assert.equal(carousel.source_issue,'carousel_not_supported');assert.equal(carousel.alternatives.length,0);C.validate(carousel,2);
});

test('hash-only images retain separate identities without substituting the creative preview and hydrate from matching hashes', () => {
  const value=C.project(common({image_url:IMAGE,asset_feed_spec:{images:[{hash:HASH},{hash:OTHER_HASH}]}}),2);
  C.validate(value,2); assert.equal(value.alternatives.length,2);
  assert(value.alternatives.every(v=>v.image_url===null&&v.source_issue==='original_media_unavailable'));
  assert.deepEqual(C.imageHashes(value),[HASH,OTHER_HASH]);
  const result=C.imageSources(value,{[HASH]:{hash:HASH,url:SECOND},[OTHER_HASH]:{error:{code:200}}});
  assert.equal(result.alternatives[0].image_url,SECOND);assert.equal(result.alternatives[0].variant_id,value.alternatives[0].variant_id);
  assert.equal(result.alternatives[1].source_issue,'image_source_permission_denied');
  assert.throws(()=>C.imageSources(value,{[HASH]:{hash:OTHER_HASH,url:SECOND}}),{code:'provider_failed'});
  assert.equal(C.project(common({asset_feed_spec:{images:[{hash:HASH}]}}),2).alternatives.length,1);
  const direct=C.project(common({image_hash:HASH}),2);
  assert.equal(direct.alternatives.length,1);assert.deepEqual(C.imageHashes(direct),[HASH]);
  const legacy=C.project(common({image_hash:HASH}),1);
  assert.equal(legacy.version,1);assert.equal(legacy.has_variants,false);assert.equal(legacy.kind,null);
  assert.equal(Object.hasOwn(legacy,'image_hash'),false);
  const platform=C.project(common({image_url:IMAGE,platform_customizations:{instagram:{image_hash:HASH}}}),2);
  assert.equal(platform.alternatives.find(a=>a.image_hash===HASH).image_url,null);
  const invalid=C.project(common({image_url:IMAGE,platform_customizations:{instagram:{image_url:'https://not-a-cdn.invalid/missing.jpg'}}}),2);
  assert(invalid.alternatives.some(a=>a.provenance.source==='platform_customizations'&&a.image_url===null&&a.source_issue==='original_media_unavailable'));
});

test('all admissible original videos hydrate independently without turning any thumbnail into a source', () => {
  const value=C.project(common({asset_feed_spec:{videos:[{video_id:'901',thumbnail_url:IMAGE},{video_id:'902',thumbnail_url:SECOND}]}}),2);
  C.validate(value,2); assert.deepEqual(C.videoIds(value),['901','902']);
  const result=C.videoSources(value,{'901':{id:'901',source:'https://video.cdninstagram.com/original.mp4'},'902':{error:{code:200}}});
  assert.equal(result.alternatives[0].original_media_url,'https://video.cdninstagram.com/original.mp4');
  assert.equal(result.alternatives[1].original_media_url,null);assert.equal(result.alternatives[1].source_issue,'video_source_permission_denied');
  assert.equal(result.alternatives[1].thumbnail_url,SECOND);assert.deepEqual(result.alternatives.map(v=>v.variant_id),value.alternatives.map(v=>v.variant_id));
  const defaults=C.project(common({video_id:'900',asset_feed_spec:{videos:[{video_id:'901'},{video_id:'902'}]}}),2);
  assert.deepEqual(C.videoIds(defaults),['901','902','900']);
});

test('options and byte bounds reject the whole ambiguous/excess projection explicitly without truncating first N', () => {
  const value=C.project(common({asset_feed_spec:{images:Array.from({length:11},(_,i)=>({url:`https://scontent.fbcdn.net/${i}.jpg`}))}}),2);
  assert.equal(value.source_issue,'creative_alternatives_limit_exceeded');assert.equal(value.alternatives.length,0);
  const long=C.project(common({body:'a'.repeat(4000),asset_feed_spec:{images:Array.from({length:10},(_,i)=>({url:`https://scontent.fbcdn.net/${i}.jpg`}))}}),2);
  assert.equal(long.alternatives.length,10);assert.equal(long.copies.length,1);assert(Buffer.byteLength(JSON.stringify(long))<10000);
  const page={data:Array.from({length:10},(_,i)=>({id:String(700+i),name:'ad',campaign_id:'401',adset_id:'402',
    creative:{id:'801',body:'a'.repeat(4000),asset_feed_spec:{
      images:Array.from({length:10},(_,j)=>({url:`https://scontent.fbcdn.net/${j}.jpg`}))}}}))};
  assert.equal(A.projectPage('ads',page,{pageToken:null,creativeVersion:2}).length,10);
});

test('v2 validator rejects orphan/duplicate copy and options, unknown fields, unsafe media and version downgrade', () => {
  for(const change of [v=>v.copies.push({...v.copies[0]}),v=>v.copies.push({...v.copies[0],body:'unbound'}),
    v=>v.alternatives[0].copy_id='f'.repeat(64),v=>v.alternatives.push({...v.alternatives[0]}),
    v=>v.alternatives[0].image_url='http://scontent.fbcdn.net/unsafe.jpg',v=>v.alternatives[0].url=IMAGE,
    v=>v.alternatives[0].provenance={source:'creative',path:'unknown'},v=>v.copies[0].body='tampered',
    v=>v.alternatives[0].image_hash='not-a-hash',v=>v.access_token='forbidden']){
    const value=pair();change(value);assert.throws(()=>C.validate(value,2),{code:'provider_failed'});
  }
  const legacy=C.project(common({image_url:IMAGE}));C.validate(legacy,1);
  assert.throws(()=>C.validate(legacy,2),{code:'provider_failed'});
  assert.throws(()=>C.validate(pair(),1),{code:'provider_failed'});
});
