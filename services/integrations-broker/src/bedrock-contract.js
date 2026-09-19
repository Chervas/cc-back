'use strict';
const Ajv = require('ajv');
const { fail } = require('./errors');
const { OPERATION, USE_CASES, REGION, MODELS, MAX_TIMEOUT_MS } = require('./bedrock-limits');
const object = (properties, required = Object.keys(properties)) => ({ type:'object', additionalProperties:false, properties, required });
const one = items => ({ type:'array', minItems:1, maxItems:1, items });
const text = { type:'string', maxLength:1048576 };
const field = { type:'string', minLength:1, maxLength:1024, not:{enum:['__proto__','prototype','constructor']} };
const outputSchema = object({ type:{const:'object'},
  properties:{type:'object',minProperties:1,maxProperties:256,propertyNames:field,
    additionalProperties:object({type:{enum:['string','number','boolean']}})},
  required:{type:'array',minItems:1,maxItems:256,uniqueItems:true,items:field}, additionalProperties:{const:false} });
const bodySchema = object({ modelId:{enum:MODELS}, system:one(object({text})),
  messages:one(object({role:{const:'user'},content:one(object({text}))})),
  inferenceConfig:object({maxTokens:{type:'integer',minimum:32,maximum:4096},temperature:{type:'number',minimum:0,maximum:1}}),
  toolConfig:object({ tools:one(object({toolSpec:object({name:{const:'submit_analysis'},
    description:{const:'Devuelve el resultado estructurado del análisis solicitado.'},inputSchema:object({json:outputSchema})})})),
    toolChoice:object({tool:object({name:{const:'submit_analysis'}})}) }) });
const bindingSchema = object({region:{const:REGION},models:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{enum:MODELS}}});
const check = new Ajv({strict:true}).compile(object({useCase:{enum:USE_CASES},
  timeoutMs:{type:'integer',minimum:1000,maximum:MAX_TIMEOUT_MS},body:bodySchema}));
function validate(value) {
  if(!check(value))fail('invalid_request');
  const schema=value.body.toolConfig.tools[0].toolSpec.inputSchema.json;
  if(Object.keys(schema.properties).sort().join('\0')!==[...schema.required].sort().join('\0'))fail('invalid_request');
  return value;
}
function authorize({request,binding}) {
  if(request.operation!==OPERATION||binding.provider!=='aws_bedrock'||binding.bedrock?.region!==REGION
    ||request.assetRef!=='ai:'+request.payload.useCase||!binding.bedrock.models.includes(request.payload.body.modelId))fail('scope_denied');
}
function credentials(value) {
  const keys=['accessKeyId','secretAccessKey',...(value?.sessionToken!==undefined?['sessionToken']:[])];
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(',')
    ||typeof value.accessKeyId!=='string'||!/^[A-Z0-9]{16,128}$/.test(value.accessKeyId)
    ||typeof value.secretAccessKey!=='string'||value.secretAccessKey.length<32||value.secretAccessKey.length>256
    ||/[\s]/.test(value.secretAccessKey)
    ||value.sessionToken!==undefined&&(typeof value.sessionToken!=='string'||value.sessionToken.length<16||value.sessionToken.length>12000||/\s/.test(value.sessionToken)))fail('secret_unavailable');
  return value;
}
module.exports = { validate, authorize, credentials, bindingSchema };
