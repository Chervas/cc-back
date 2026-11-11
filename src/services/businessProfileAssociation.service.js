'use strict';
const C=require('./businessProfileAssociation.contract');
const {createRepositoryForAssociation}=require('./businessProfileAssociation.repository');
const {configuredClient}=require('./businessProfileAssociationClient.service');
const SAFE=new Set(['gbp_association_review_link_unavailable','gbp_association_own_session_required','gbp_association_review_impact_changed','gbp_association_inherited_asset','gbp_association_invalid','gbp_association_disabled','gbp_association_session_required','gbp_association_scope_unconfigured','gbp_association_scope_conflict','gbp_association_identity_mismatch','gbp_association_scope_changed','gbp_association_original_session_required','gbp_association_current_ambiguous','gbp_association_inherited_asset','gbp_association_oauth_anchor','gbp_association_shared_dependency','gbp_association_review_dependency','gbp_association_campaign_dependency','gbp_association_mutation_pending','gbp_association_target_forbidden','gbp_association_already_current','gbp_association_location_in_use','gbp_association_not_found','gbp_association_not_ready','gbp_association_busy','gbp_association_limit','gbp_association_unavailable','broker_binding_invalid','broker_response_invalid','scope_denied','operation_denied','asset_revoked','connection_blocked','credential_revoked','provider_unauthorized','provider_failed','provider_timeout','rate_limited','audit_unavailable','broker_timeout','broker_unavailable','outcome_unknown','idempotency_conflict']);
const safe=e=>SAFE.has(e?.code)?e.code:'gbp_association_unavailable';
const status=e=>safe(e)==='gbp_association_review_link_unavailable'?409:safe(e)==='gbp_association_session_required'?401:safe(e)==='gbp_association_original_session_required'?409:['gbp_association_own_session_required','scope_denied','gbp_association_target_forbidden'].includes(safe(e))?403:safe(e)==='gbp_association_not_found'?404:safe(e)==='gbp_association_invalid'?400:['gbp_association_busy','rate_limited'].includes(safe(e))?429:['_inherited_asset','_mismatch','_conflict','_changed','_ambiguous','_anchor','_dependency','_pending','_in_use','_current','_not_ready','_unconfigured'].some(t=>safe(e).endsWith(t))||['asset_revoked','broker_binding_invalid','idempotency_conflict'].includes(safe(e))?409:503;
function createAssociationService({models,sessions,audit,authorize,repository,client,now=()=>new Date(),enabled=()=>process.env.GOOGLE_BUSINESS_PROFILE_ASSOCIATION_ENABLED==='true'}) {
  const repo=repository || createRepositoryForAssociation({models,sessions,audit,authorize,now,enabled});
  const broker=client || configuredClient(); let discoveries=0; const advancing=new Set();
  const guard=fn=>async(...args)=>{try{return await fn(...args);}catch(error){C.fail(safe(error));}};
  async function inspect(input,checkDependencies=true){return repo.snapshot(input,{checkDependencies,allowReviewChange:true});}
  async function discover(input){
    if(discoveries>=4)C.fail('gbp_association_busy');discoveries++;
    try {const captured=await inspect(input);const check=()=>repo.snapshot(input,{expectedFingerprint:captured.sourceFingerprint,expectedAuthority:captured.authorityDigest,allowReviewChange:true});
      const choices=await broker.discover(captured.scope,check);await check();return {captured,choices};
    }finally{discoveries--;}
  }
  async function advance(input,id){
    if(advancing.has(id))return repo.history(input,id);advancing.add(id);
    try {const deadline=now().getTime()+25000;
      for(let step=0;step<4&&now().getTime()<deadline;step++){
        const claim=await repo.claim(input,id);if(!claim)break;
        const before=()=>repo.assertClaim(input,claim);
        try {
          if(claim.state==='prepare_pending'){
            let result;if(Number(claim.attempts)>1){result=await broker.command(claim,'status',before);if(result.state==='not_found'){Object.assign(claim,await repo.rotateCommand(input,claim,'prepare'));result=null;}}
            if(!result)result=await broker.command(claim,'prepare',before);
            if(!['prepared','active'].includes(result.state)||result.accessBlocked)C.fail('broker_response_invalid');
            await repo.prepared(input,claim);break;
          }
          if(claim.state==='activate_pending'){
            let result;if(Number(claim.attempts)>1){result=await broker.command(claim,'status',before);if(result.state==='prepared')Object.assign(claim,await repo.rotateCommand(input,claim,'activate'));else if(result.state!=='active')C.fail('broker_response_invalid');}
            if(result?.state!=='active')result=await broker.command(claim,'activate',before);
            if(result.state!=='active'||result.accessBlocked)C.fail('broker_response_invalid');await repo.activated(input,claim);continue;
          }
          if(claim.state==='broker_active'){await before();await repo.swap(input,claim);continue;}
          if(claim.state==='retire_pending'){
            let result=await broker.command(claim,'status',before);
            if(result.state!=='active'&&result.state!=='retired')C.fail('broker_response_invalid');
            if(!result.previousAssetRetired){Object.assign(claim,await repo.rotateCommand(input,claim,'retire'));result=await broker.command(claim,'retire',before);}
            if(!result.previousAssetRetired||!['active','retired'].includes(result.state))C.fail('broker_response_invalid');await repo.retired(input,claim);continue;
          }
          if(claim.state==='cancel_pending'){
            let result=await broker.command(claim,'status',before);if(result.state!=='cancelled'){if(!['not_found','prepared','active'].includes(result.state))C.fail('broker_response_invalid');Object.assign(claim,await repo.rotateCommand(input,claim,'abort'));result=await broker.command(claim,'abort',before);}if(result.state!=='cancelled'||!result.accessBlocked)C.fail('broker_response_invalid');await repo.cancelled(input,claim);break;
          }
        }catch(error){try{await repo.retry(claim,safe(error));}catch(retryError){if(retryError?.code!=='gbp_association_busy')throw retryError;}break;}
      }
      return repo.history(input,id);
    }finally{advancing.delete(id);}
  }
  const userDto=(row,input)=>{const original=Number(row.actor_user_id)===Number(input.actorId)&&row.session_ref===input.sessionRef&&new Date(row.session_expires_at).getTime()===input.sessionExpiresAt&&input.sessionExpiresAt>now().getTime();return {...C.dto(row),canConfirm:row.state==='prepared'&&original,error:row.state==='prepared'&&!original?'gbp_association_original_session_required':row.last_error||null};};
  return {
    capabilities:guard(async input=>{
      const off={enabled:false,changeAllowed:false,clinicId:Number(input.clinicId),clinicName:'',sourceFingerprint:null,current:null,reason:'gbp_association_disabled',reviewDestinationChangeRequired:false,affectedReviewCampaignCount:0};
      if(!enabled())return off;
      let captured;try{captured=await inspect(input,false);}catch(error){if(['gbp_association_scope_unconfigured','gbp_association_disabled'].includes(error?.code))return {...off,reason:error.code};throw error;}
      const base={enabled:true,changeAllowed:true,clinicId:Number(input.clinicId),clinicName:captured.clinic.nombre_clinica||'',sourceFingerprint:captured.sourceFingerprint,current:C.target(captured.source),reason:null,reviewDestinationChangeRequired:false,affectedReviewCampaignCount:0};
      try{const impact=await inspect(input);base.sourceFingerprint=impact.sourceFingerprint;base.reviewDestinationChangeRequired=impact.reviewDestinationChangeRequired;base.affectedReviewCampaignCount=impact.affectedReviewCampaignCount;}catch(error){if(['gbp_association_inherited_asset','gbp_association_oauth_anchor','gbp_association_shared_dependency','gbp_association_review_dependency','gbp_association_campaign_dependency','gbp_association_mutation_pending'].includes(error?.code))return {...base,changeAllowed:false,reason:error.code};throw error;}
      return base;
    }),
    candidates:guard(async input=>{const {captured,choices}=await discover(input);const accounts=new Map();for(const item of choices){if(!accounts.has(item.accountName))accounts.set(item.accountName,{accountName:item.accountName,accountDisplayName:item.rawLocation.accountDisplayName||item.accountName,locations:[]});accounts.get(item.accountName).locations.push({locationId:item.locationName,name:item.name,address:item.address});}return {sourceFingerprint:captured.sourceFingerprint,accounts:[...accounts.values()],reviewDestinationChangeRequired:captured.reviewDestinationChangeRequired,affectedReviewCampaignCount:captured.affectedReviewCampaignCount};}),
    list:guard(async input=>{const history=await repo.history(input);return {attempts:history.rows.map(row=>userDto(row,input)),hasMore:history.hasMore};}),
    prepare:guard(async(input,payload)=>{
      if(!payload||!['accountName,attemptId,locationName,sourceFingerprint','accountName,attemptId,locationName,reviewDestinationChangeAccepted,sourceFingerprint'].includes(Object.keys(payload).sort().join(','))||payload.reviewDestinationChangeAccepted!==undefined&&typeof payload.reviewDestinationChangeAccepted!=='boolean'||!C.UUID.test(payload.attemptId)||!C.HASH.test(payload.sourceFingerprint))C.fail();C.resource(payload.accountName,'accounts');C.resource(payload.locationName,'locations');
      try {const existing=await repo.history(input,payload.attemptId);if(existing.source_fingerprint!==payload.sourceFingerprint||existing.account_id!==C.resource(payload.accountName,'accounts')||existing.location_id!==C.resource(payload.locationName,'locations')||(C.object(existing.target_snapshot).reviewDestinationChangeAccepted===true)!==(payload.reviewDestinationChangeAccepted===true))C.fail('idempotency_conflict');return {attempt:userDto(await advance(input,payload.attemptId),input)};}catch(error){if(error?.code!=='gbp_association_not_found')throw error;}
      const {captured,choices}=await discover(input);if(captured.reviewDestinationChangeRequired&&payload.reviewDestinationChangeAccepted!==true)C.fail('gbp_association_campaign_dependency');if(captured.sourceFingerprint!==payload.sourceFingerprint)C.fail('gbp_association_scope_changed');
      const selected=choices.filter(row=>row.accountName===payload.accountName&&row.locationName===payload.locationName);if(selected.length!==1)C.fail('gbp_association_target_forbidden');
      await repo.enqueue(input,payload,selected[0],captured.authorityDigest);return {attempt:userDto(await advance(input,payload.attemptId),input)};
    }),
    read:guard(async(input,id)=>{if(!C.UUID.test(id))C.fail();await repo.history(input,id);return {attempt:userDto(await advance(input,id),input)};}),
    confirm:guard(async(input,id)=>{if(!C.UUID.test(id))C.fail();await repo.transition(input,id,'confirm');return {attempt:userDto(await advance(input,id),input)};}),
    cancel:guard(async(input,id)=>{if(!C.UUID.test(id))C.fail();await repo.transition(input,id,'cancel');return {attempt:userDto(await advance(input,id),input)};}),
  };
}
let instance;const get=()=>instance||=createAssociationService({models:()=>require('../../models')});
module.exports={createAssociationService,safe,status,...Object.fromEntries(['capabilities','candidates','list','prepare','read','confirm','cancel'].map(name=>[name,(...args)=>get()[name](...args)]))};
