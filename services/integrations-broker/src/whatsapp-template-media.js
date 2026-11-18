'use strict';
const https=require('node:https');const dns=require('node:dns').promises;
const {BlockList,isIP}=require('node:net');
const {fail,BrokerError}=require('./errors');const {GRAPH_VERSION}=require('./whatsapp-contract');
const MAX=5*1024*1024;const VIDEO_MAX=16*1024*1024;
const blocked=new BlockList(); const blocked6=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(ip,prefix,'ipv4');
for(const [ip,prefix] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8]])blocked6.addSubnet(ip,prefix,'ipv6');
function publicAddress(address){const family=isIP(address);return !!family&&!(family===4?blocked:blocked6).check(address,family===4?'ipv4':'ipv6');}
function sourceUrl(value){
  let u;try{u=new URL(value);}catch{fail('invalid_request');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||u.href.length>4096)fail('invalid_request');
  return u;
}
// Parse bounded ISO-BMFF boxes instead of trusting an extension or MIME header.
// Template videos use one H.264 video track and at most one AAC audio track.
function boxes(data,start=0,end=data.length){
  const result=[];
  while(start<end){
    if(end-start<8||result.length>=10000)return null;
    let size=data.readUInt32BE(start),header=8;
    if(size===1){if(end-start<16)return null;const large=data.readBigUInt64BE(start+8);if(large>BigInt(end-start))return null;size=Number(large);header=16;}
    else if(size===0)size=end-start;
    if(size<header||size>end-start)return null;
    result.push({type:data.toString('ascii',start+4,start+8),start:start+header,end:start+size});start+=size;
  }
  return result;
}
function isMp4(data){
  const top=boxes(data);if(!top)return false;
  if(top.filter(b=>b.type==='ftyp').length!==1||top.filter(b=>b.type==='moov').length!==1)return false;
  const ftyp=top.find(b=>b.type==='ftyp'),moov=top.find(b=>b.type==='moov');
  if(!ftyp||ftyp.end-ftyp.start<8||(ftyp.end-ftyp.start)%4||!moov||!top.some(b=>b.type==='mdat'&&b.end>b.start))return false;
  const brands=[data.toString('ascii',ftyp.start,ftyp.start+4)];
  for(let i=ftyp.start+8;i<ftyp.end;i+=4)brands.push(data.toString('ascii',i,i+4));
  if(!brands.some(b=>['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','M4V '].includes(b)))return false;
  const children=b=>b?boxes(data,b.start,b.end):null;
  const tracks=children(moov);if(!tracks)return false;let videos=0,audios=0;
  for(const track of tracks.filter(b=>b.type==='trak')){
    const mdia=children(track)?.find(b=>b.type==='mdia'),parts=children(mdia),hdlr=parts?.find(b=>b.type==='hdlr');
    if(!hdlr||hdlr.end-hdlr.start<12)return false;
    const handler=data.toString('ascii',hdlr.start+8,hdlr.start+12);
    if(!['vide','soun'].includes(handler))return false;
    const minf=parts.find(b=>b.type==='minf'),stbl=children(minf)?.find(b=>b.type==='stbl'),stsd=children(stbl)?.find(b=>b.type==='stsd');
    if(!stsd||stsd.end-stsd.start<8)return false;
    const entries=boxes(data,stsd.start+8,stsd.end);
    if(!entries||entries.length!==1||data.readUInt32BE(stsd.start+4)!==1)return false;
    if(handler==='vide'){
      if(!['avc1','avc3'].includes(entries[0].type)||entries[0].end-entries[0].start<78)return false;
      const config=boxes(data,entries[0].start+78,entries[0].end)?.find(b=>b.type==='avcC');
      if(!config||config.end-config.start<7||data[config.start]!==1)return false;videos++;
    }else{if(entries[0].type!=='mp4a')return false;audios++;}
  }
  return videos===1&&audios<=1;
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
  return async({source,format='IMAGE',appId,token,proof,signal,assertActive})=>{
    if(!['IMAGE','VIDEO'].includes(format))fail('invalid_request');
    const url=sourceUrl(source);const hostname=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=await lookup(hostname,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))fail('invalid_request');
    assertActive();
    // Public CDN/WAF policies may reject anonymous clients without User-Agent.
    // Identify this downloader without forwarding any Meta credential.
    const image=await transfer(url,{address:addresses[0],signal,max:format==='VIDEO'?VIDEO_MAX:MAX,headers:{'user-agent':'Clinicaclick-Template-Media/1.0'}});
    try{
      if(!image.length)fail('invalid_request');
      const type=format==='VIDEO'?(isMp4(image)?'video/mp4':null):image.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':image.subarray(0,4).toString()==='RIFF'&&image.subarray(8,12).toString()==='WEBP'?'image/webp':null;
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
module.exports={createTemplateMedia,publicAddress,sourceUrl,isMp4,MAX,VIDEO_MAX};
