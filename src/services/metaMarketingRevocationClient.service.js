'use strict';
const {createConfiguredMetaMarketingClient}=require('./metaMarketingBrokerReader.service');
const {REVOKE}=require('./metaMarketingRevocation.contract');
function createClient({env=process.env}={}){
  const controlEnv={};
  for(const name of ['ORIGIN','AUDIENCE','KEY_ID','KEY_FILE','CA_FILE'])Object.defineProperty(controlEnv,'META_MARKETING_BROKER_'+name,{enumerable:true,
    get:()=>env['META_MARKETING_BROKER_'+(['KEY_ID','KEY_FILE'].includes(name)?'CONTROL_':'')+name]});
  const transport=createConfiguredMetaMarketingClient({env:controlEnv});
  return {execute(command,budget){
    if(command?.operation!==REVOKE||!command.payload||Object.keys(command.payload).length)throw Object.assign(Error('operation_denied'),{code:'operation_denied'});
    return transport.execute(command,budget);
  }};
}
module.exports={createClient,client:createClient()};
