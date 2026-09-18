'use strict';
const https = require('node:https');
const { Readable } = require('node:stream');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { BrokerError, fail } = require('./errors');
const { REGION } = require('./bedrock-limits');
const { PROVIDER_ERRORS } = require('./bedrock-errors');
const contract = require('./bedrock-contract');
const MAX_REPLY_BYTES = 1024*1024;
function limitedHandler(inner, modelId) {
  const hostname=`bedrock-runtime.${REGION}.amazonaws.com`;
  return { metadata:inner.metadata,
    async handle(request, options) {
      if(request.protocol!=='https:'||request.hostname!==hostname||request.port&&request.port!==443
        ||request.method!=='POST'||request.path!=='/model/'+encodeURIComponent(modelId)+'/converse'
        ||Object.keys(request.query||{}).length) fail('invalid_request');
      const result=await inner.handle(request,options);
      const body=result.response.body;const chunks=[];let size=0;
      const abort=()=>body.destroy(new BrokerError('provider_timeout'));
      options?.abortSignal?.addEventListener('abort',abort,{once:true});
      try {
        if(options?.abortSignal?.aborted)abort();
        for await(const chunk of body) {
          size+=chunk.length;
          if(size>MAX_REPLY_BYTES){body.destroy();fail('provider_failed');}
          chunks.push(Buffer.from(chunk));
        }
        result.response.body=Readable.from([Buffer.concat(chunks)]);
        return result;
      } finally { options?.abortSignal?.removeEventListener('abort',abort); }
    },
    updateHttpClientConfig:(...args)=>inner.updateHttpClientConfig?.(...args),
    httpHandlerConfigs:()=>inner.httpHandlerConfigs?.()||{},
    destroy:()=>inner.destroy?.(),
  };
}
function project(response) {
  if(!response||typeof response!=='object')fail('provider_failed');
  const tool=response.output?.message?.content?.find(item=>item?.toolUse?.name==='submit_analysis')?.toolUse;
  const content=tool&&tool.input&&typeof tool.input==='object'&&!Array.isArray(tool.input)
    ? [{toolUse:{name:'submit_analysis',input:tool.input}}]:[];
  const number=value=>Number.isFinite(Number(value))&&Number(value)>=0?Number(value):0;
  return { output:{message:{content}}, usage:{inputTokens:number(response.usage?.inputTokens),
    outputTokens:number(response.usage?.outputTokens),totalTokens:number(response.usage?.totalTokens)},
    metrics:{latencyMs:number(response.metrics?.latencyMs)},
    stopReason:typeof response.stopReason==='string'?response.stopReason.slice(0,80):'',
    $metadata:{requestId:typeof response.$metadata?.requestId==='string'?response.$metadata.requestId.slice(0,120):''} };
}
function createBedrockHttp({ clientFactory=config=>new BedrockRuntimeClient(config),
  handlerFactory=()=>new NodeHttpHandler({httpsAgent:new https.Agent({keepAlive:false,maxSockets:1}),connectionTimeout:5000}) }={}) {
  return async ({payload,token,signal})=>{
    contract.validate(payload);
    let credentials;
    try {credentials=contract.credentials(JSON.parse(token.toString('utf8')));}catch{fail('secret_unavailable');}
    // The SDK annotates its credential object with non-secret metadata. Keep
    // only the validated credential strings for the reflection check.
    const credentialValues=Object.values(credentials);
    const controller=new AbortController();const abort=()=>controller.abort();
    if(signal?.aborted)fail('provider_timeout');
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,payload.timeoutMs);timer.unref?.();
    let client,handler;
    try {
      handler=limitedHandler(handlerFactory(),payload.body.modelId);
      client=clientFactory({region:REGION,credentials,
        endpoint:`https://bedrock-runtime.${REGION}.amazonaws.com`,
        useFipsEndpoint:false,useDualstackEndpoint:false,
        // Preserve the direct adapter's two SDK attempts. The signed operation
        // itself is never replayed; the orchestrator retains its model fallback.
        retryMode:'standard',maxAttempts:2,requestHandler:handler});
      const response=await client.send(new ConverseCommand(payload.body),{abortSignal:controller.signal});
      if(controller.signal.aborted)fail('provider_timeout');
      const data=project(response);const serialized=JSON.stringify(data);
      if(Buffer.byteLength(serialized)>MAX_REPLY_BYTES)fail('provider_failed');
      for(const value of credentialValues)
        if([value,encodeURIComponent(value),Buffer.from(value).toString('base64')].some(part=>serialized.includes(part)))fail('provider_failed');
      return data;
    } catch(error) {
      if(controller.signal.aborted||error.name==='AbortError')fail('provider_timeout');
      if(error instanceof BrokerError)throw error;
      if(['AccessDeniedException','UnrecognizedClientException','InvalidSignatureException','ExpiredTokenException'].includes(error.name))fail('provider_unauthorized');
      const status=Number(error.$metadata?.httpStatusCode);
      if(status===401||status===403)fail('provider_unauthorized');
      fail(PROVIDER_ERRORS[error.name]||(status===429?'bedrock_throttled':status===408?'bedrock_model_timeout':status>=500&&status<=599?'bedrock_internal_error':'provider_failed'));
    } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort);client?.destroy?.();handler?.destroy?.(); }
  };
}
module.exports = { createBedrockHttp, limitedHandler, project, MAX_REPLY_BYTES };
