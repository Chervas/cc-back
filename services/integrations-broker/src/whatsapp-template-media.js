'use strict';
const https=require('node:https');const dns=require('node:dns').promises;
const {BlockList,isIP}=require('node:net');
const {fail,BrokerError}=require('./errors');const {GRAPH_VERSION}=require('./whatsapp-contract');
const MAX=5*1024*1024;
const blocked=new BlockList(); const blocked6=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(ip,prefix,'ipv4');
for(const [ip,prefix] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8]])blocked6.addSubnet(ip,prefix,'ipv6');
function publicAddress(address){const family=isIP(address);return !!family&&!(family===4?blocked:blocked6).check(address,family===4?'ipv4':'ipv6');}
function sourceUrl(value){
  let u;try{u=new URL(value);}catch{fail('invalid_request');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||u.href.length>4096)fail('invalid_request');
  return u;
}
function createTemplateMedia({request=https.request,lookup=dns.lookup}={}){
  const transfer=(url,{method='GET',headers={},body,signal,address,max=MAX,json=false}={})=>new Promise((resolve,reject)=>{
    let done=false;const finish=(err,value)=>{if(done)return;done=true;err?reject(err):resolve(value);};
    const req=request(url,{method,headers,signal,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',
      ...(address?{lookup:(_host,options,cb)=>options?.all?cb(null,[address]):cb(null,address.address,address.family)}:{})},res=>{
      if(res.statusCode<200||res.statusCode>=300){finish(new BrokerError('provider_failed'));res.destroy();return;}
      let bytes=0;const chunks=[];
      res.on('data',c=>{bytes+=c.length;if(bytes>max){finish(new BrokerError('invalid_request'));res.destroy();}else chunks.push(c);});
      res.on('error',()=>finish(new BrokerError('provider_failed')));res.on('aborted',()=>finish(new BrokerError('provider_failed')));
      res.on('end',()=>{try{const data=Buffer.concat(chunks);finish(null,json?JSON.parse(data.toString('utf8')):data);}catch{finish(new BrokerError('provider_failed'));}});
    });
    req.setTimeout(8000,()=>{finish(new BrokerError('provider_timeout'));req.destroy();});
    req.on('error',()=>finish(new BrokerError('provider_failed')));req.end(body);
  });
  return async({source,appId,token,proof,signal,assertActive})=>{
    const url=sourceUrl(source);const hostname=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=await lookup(hostname,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))fail('invalid_request');
    assertActive();
    // Public CDN/WAF policies may reject anonymous clients without User-Agent.
    // Identify this downloader without forwarding any Meta credential.
    const image=await transfer(url,{address:addresses[0],signal,headers:{'user-agent':'Clinicaclick-Template-Media/1.0'}});
    try{
      if(!image.length)fail('invalid_request');
      const type=image.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':image.subarray(0,4).toString()==='RIFF'&&image.subarray(8,12).toString()==='WEBP'?'image/webp':null;
      if(!type)fail('invalid_request');
      assertActive();const query=new URLSearchParams({file_name:'template-header.'+type.split('/')[1],file_length:String(image.length),file_type:type,appsecret_proof:proof});
      const headers={authorization:'OAuth '+token.toString('utf8'),accept:'application/json'};
      const session=await transfer(new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads?${query}`),{method:'POST',headers,json:true,max:16384,signal});
      if(typeof session.id!=='string'||!/^upload:[A-Za-z0-9_=:.-]+(?:\?sig=[A-Za-z0-9_=-]+)?$/.test(session.id)||session.id.length>2048)fail('provider_failed');
      assertActive();
      const uploadUrl=new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${session.id}`);uploadUrl.searchParams.set('appsecret_proof',proof);
      const result=await transfer(uploadUrl,{method:'POST',headers:{...headers,file_offset:'0','content-type':type,'content-length':image.length},body:image,json:true,max:16384,signal});
      if(typeof result.h!=='string'||!result.h.length||result.h.length>8192)fail('provider_failed');
      return {handle:result.h};
    }finally{image.fill(0);}
  };
}
module.exports={createTemplateMedia,publicAddress,sourceUrl};
