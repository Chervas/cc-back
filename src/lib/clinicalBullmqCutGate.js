'use strict';
// Operator-only pause with durable ownership and no automatic expiry/resume.
// Reuse the exact installed BullMQ pause script, including priority/delay markers.
const {createHash}=require('node:crypto');
const {pause}=require('bullmq/dist/cjs/scripts/pause-7');
if(pause.keys!==7 || createHash('sha256').update(pause.content).digest('hex')!=='ef92926f5a206d2650b4c2fb15c1019f03f2f18e2351ff6a52fdccdc449bfc0d')throw Error('clinical_cut_bullmq_contract_changed');
const vendor='local function vendorPause()\n'+pause.content+'\nend\n';
const ownership=`
local raw=redis.call('GET',KEYS[8])
local receipt=raw and cjson.decode(raw) or nil
local token=ARGV[2]
if receipt and (type(receipt)~='table' or receipt.version~=1 or receipt.scope~=KEYS[3]
  or type(receipt.token)~='string') then
  error('clinical_cut_queue_receipt_corrupt')
end
if receipt and receipt.state~='held' and receipt.state~='preserved' and receipt.state~='restored' then
  error('clinical_cut_queue_partial_operation_requires_review')
end
local expected={'list','list','hash','zset','stream','zset','zset','string'}
for i=1,#KEYS do
  local kind=redis.call('TYPE',KEYS[i]).ok
  if kind~='none' and kind~=expected[i] then error('clinical_cut_queue_key_type_invalid') end
end
local function validateHeld()
  if redis.call('HEXISTS',KEYS[3],'paused')~=1 then error('clinical_cut_queue_pause_changed') end
  if redis.call('EXISTS',KEYS[1])~=0 and ARGV[1]=='paused' then error('clinical_cut_queue_wait_list_changed') end
  local own=redis.call('XRANGE',KEYS[5],receipt.eventId,receipt.eventId)
  if #own~=1 then error('clinical_cut_queue_pause_history_missing') end
  local later=redis.call('XRANGE',KEYS[5],'('..receipt.eventId,'+','COUNT',257)
  if #later>256 then error('clinical_cut_queue_pause_history_limit') end
  for _,event in ipairs(later) do
    for i=1,#event[2],2 do
      if event[2][i]=='event' and (event[2][i+1]=='paused' or event[2][i+1]=='resumed') then
        error('clinical_cut_queue_external_control')
      end
    end
  end
end
`;
const acquire=vendor+ownership+`
if receipt and receipt.state=='held' then
  if receipt.token~=token then error('clinical_cut_queue_owned') end
  validateHeld();return raw
end
if receipt and receipt.token==token then return raw end
if redis.call('EXISTS',KEYS[3])~=1 then error('clinical_cut_queue_missing') end
if redis.call('HEXISTS',KEYS[3],'paused')==1 then
  receipt={version=1,scope=KEYS[3],token=token,state='preserved',priorPaused=true}
else
  if redis.call('EXISTS',KEYS[2])~=0 then error('clinical_cut_queue_pause_list_changed') end
  redis.call('SET',KEYS[8],cjson.encode({version=1,scope=KEYS[3],token=token,state='preparing',priorPaused=false}))
  vendorPause()
  local event=redis.call('XREVRANGE',KEYS[5],'+','-','COUNT',1)
  receipt={version=1,scope=KEYS[3],token=token,state='held',priorPaused=false,eventId=event[1][1]}
end
local result=cjson.encode(receipt);redis.call('SET',KEYS[8],result);return result
`;
const verify=ownership+`
if not receipt or receipt.token~=token then error('clinical_cut_queue_owner_missing') end
if receipt.state=='held' then validateHeld()
elseif receipt.state=='preserved' then
  if redis.call('HEXISTS',KEYS[3],'paused')~=1 then error('clinical_cut_queue_pause_changed') end
else error('clinical_cut_queue_not_held') end
return raw
`;
const restore=vendor+ownership+`
if not receipt or receipt.token~=token then error('clinical_cut_queue_owner_missing') end
if receipt.state=='restored' or receipt.state=='preserved' then return raw end
if receipt.state~='held' then error('clinical_cut_queue_state_invalid') end
validateHeld()
if redis.call('EXISTS',KEYS[2])~=0 then error('clinical_cut_queue_wait_list_changed') end
receipt.state='restoring';redis.call('SET',KEYS[8],cjson.encode(receipt));vendorPause()
local event=redis.call('XREVRANGE',KEYS[5],'+','-','COUNT',1)
receipt.state='restored';receipt.restoreEventId=event[1][1]
local result=cjson.encode(receipt);redis.call('SET',KEYS[8],result);return result
`;
function clinicalBullmqCutGate({client,prefix,name,token}) {
  if(!client?.eval || !/^[a-zA-Z0-9_-]{1,100}$/.test(prefix||'')
    || !['outbound_whatsapp','webhook_whatsapp','whatsapp_template_create','whatsapp_template_sync','whatsapp_phone_sync','automation_defaults'].includes(name)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token||''))throw Error('clinical_cut_queue_arguments_invalid');
  const base=prefix+':'+name+':';
  const keys=[base+'wait',base+'paused',base+'meta',base+'prioritized',base+'events',base+'delayed',base+'marker','cc:clinical-cut:'+prefix+':'+name];
  const execute=async(script,resume=false)=>{
    const actual=[...keys];if(resume)[actual[0],actual[1]]=[actual[1],actual[0]];
    const receipt=JSON.parse(await client.eval(script,actual.length,...actual,resume?'resumed':'paused',token));
    if(receipt.token!==token || !['held','preserved','restored'].includes(receipt.state))throw Error('clinical_cut_queue_receipt_invalid');
    return {prefix,name,...receipt};
  };
  return Object.freeze({acquire:()=>execute(acquire),verify:()=>execute(verify),restore:()=>execute(restore,true),
    receipt:async()=>{const raw=await client.get(keys[7]);return raw?JSON.parse(raw):null;}});
}
module.exports={clinicalBullmqCutGate};
