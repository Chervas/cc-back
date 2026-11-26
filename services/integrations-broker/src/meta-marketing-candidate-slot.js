'use strict';

const {CreateSecretCommand,DescribeSecretCommand,GetSecretValueCommand}=require('@aws-sdk/client-secrets-manager');
const C=require('./meta-marketing-oauth-contract');
const P=require('./meta-marketing-admission-contract');
const {canonical}=require('./canonical');
const {BrokerError,fail}=require('./errors');
const {SECRET_KEY}=require('./google-main');

// Only verifies or creates the empty sentinel. No provider credential is promoted.
function candidateSlot(client, managedBy, appId) {
  const tagsFor=row=>[{Key:'ManagedBy',Value:managedBy},
    {Key:'ClinicaclickScope',Value:row.scope},{Key:'Purpose',Value:'candidate'}];
  const placeholderFor=row=>({version:1,provider:'meta-marketing-oauth-slot',connectionRef:row.connection,
    scopeKey:row.scope,clinicSetDigest:C.hash(row.clinic_ids),appId:row.app_id||appId});
  const validArn=(value,row)=>typeof value==='string'&&value.startsWith(P.ARN_PREFIX+row.name+'-')
    &&/^[A-Za-z0-9]{6}$/.test(value.slice((P.ARN_PREFIX+row.name+'-').length));
  async function observe(row,signal){
    let metadata;
    try{metadata=await client.send(new DescribeSecretCommand({SecretId:row.arn||row.name}),{abortSignal:signal});}
    catch(error){if(error?.name==='ResourceNotFoundException')return null;throw error;}
    if(signal.aborted||!validArn(metadata.ARN,row)||metadata.Name!==row.name||metadata.KmsKeyId!==SECRET_KEY||metadata.DeletedDate
      ||!metadata.VersionIdsToStages?.[row.version_id]?.includes('AWSCURRENT')
      ||Object.entries(metadata.VersionIdsToStages).some(([id,stages])=>id!==row.version_id&&stages.includes('AWSCURRENT'))
      ||tagsFor(row).some(tag=>!metadata.Tags?.some(value=>value.Key===tag.Key&&value.Value===tag.Value)))fail('secret_unavailable');
    const value=await client.send(new GetSecretValueCommand({SecretId:metadata.ARN,VersionId:row.version_id,VersionStage:'AWSCURRENT'}),{abortSignal:signal});
    try{
      if(signal.aborted||value.ARN!==metadata.ARN||value.VersionId!==row.version_id||!value.VersionStages?.includes('AWSCURRENT')
        ||typeof value.SecretString!=='string'||Buffer.byteLength(value.SecretString)>2048
        ||canonical(JSON.parse(value.SecretString))!==canonical(placeholderFor(row)))fail('secret_unavailable');
      return metadata.ARN;
    }finally{delete value.SecretString;value.SecretBinary?.fill?.(0);}
  }
  async function ensureSlot(row,signal){
    let arn=await observe(row,signal);if(arn)return arn;
    if(row.state==='ready')fail('secret_unavailable');
    let createError;
    try{await client.send(new CreateSecretCommand({Name:row.name,KmsKeyId:SECRET_KEY,ClientRequestToken:row.version_id,
      SecretString:JSON.stringify(placeholderFor(row)),Tags:tagsFor(row)}),{abortSignal:signal});}catch(error){createError=error;}
    arn=await observe(row,signal);if(!arn)throw createError||new BrokerError('secret_unavailable');return arn;
  }
  return ensureSlot;
}
module.exports={candidateSlot};
