'use strict';
const B=require('../../services/integrations-broker/src/meta-marketing-oauth-contract'),C=require('./metaMarketingOAuth.contract');
const D=require('../../services/integrations-broker/src/meta-marketing-discovery-contract');
const E=require('../../services/integrations-broker/src/meta-marketing-enrollment-contract');
const ALLOWED=new Set([...Object.values(B.OPERATIONS),D.OPERATION,...Object.values(E.OPERATIONS)]);
const CONTROL=new Set([B.OPERATIONS.abort,B.OPERATIONS.status,E.OPERATIONS.status,E.OPERATIONS.revoke]);
function createClient({env=process.env}={}){
  const clients=new Map();
  return {execute(command,budget){
    if(!ALLOWED.has(command?.operation))C.fail();
    const control=CONTROL.has(command.operation);
    const prefix='META_MARKETING_OAUTH_BROKER';
    const values={META_MARKETING_BROKER_ORIGIN:env[prefix+'_ORIGIN'],META_MARKETING_BROKER_AUDIENCE:env[prefix+'_AUDIENCE'],
      META_MARKETING_BROKER_KEY_ID:env[prefix+(control?'_CONTROL':'')+'_KEY_ID'],META_MARKETING_BROKER_KEY_FILE:env[prefix+(control?'_CONTROL':'')+'_KEY_FILE'],META_MARKETING_BROKER_CA_FILE:env[prefix+'_CA_FILE']};
    if(!clients.has(control))clients.set(control,{values,client:require('./metaMarketingBrokerReader.service').createConfiguredMetaMarketingClient({env:values})});
    const cached=clients.get(control);if(JSON.stringify(values)!==JSON.stringify(cached.values))C.fail('broker_configuration_invalid');
    return cached.client.execute(command,budget);
  }};
}
module.exports={createClient};
