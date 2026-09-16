'use strict';
const MEDIA = new Set(['audio','image','video','document','sticker']);
const clean = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g,' ').slice(0,n) : null;
function details(message) {
  const kind=message?.type, value=message?.[kind]; const result={};
  if (MEDIA.has(kind) && value && /^[1-9][0-9]{0,29}$/.test(value.id || '')) {
    result.media={kind,id:value.id,mime_type:clean(value.mime_type,128),sha256:clean(value.sha256,128),
      provider:'whatsapp',stored:false,playable:true,...(kind==='audio'?{voice:value.voice===true}:{}),
      ...(kind==='document'?{filename:clean(value.filename,255)}:{})};
    if(kind==='audio')result.audio_transcribed=false;
  }
  if(kind==='reaction') result.reaction={emoji:clean(value?.emoji,32)||'',message_id:clean(value?.message_id,512)};
  if(message?.context?.id) result.context={id:clean(message.context.id,512)};
  if(kind==='interactive') result.interactive=Object.fromEntries(['type','button_reply','list_reply'].filter(k=>value?.[k]).map(k=>[k,typeof value[k]==='string'?clean(value[k],32):{id:clean(value[k].id,512),title:clean(value[k].title,1024)}]));
  return result;
}
function errors(status) {
  return (Array.isArray(status?.errors)?status.errors:[]).slice(0,5).filter(e=>Number.isSafeInteger(e?.code)&&e.code>0).map(e=>({
    code:e.code,title:clean(e.title,256),message:clean(e.message,512),
    ...(e.error_data?.details?{error_data:{details:clean(e.error_data.details,1024)}}:{})
  }));
}
function messageType(providerType) { return providerType==='image'?'image':providerType==='reaction'?'reaction':'event'; }
module.exports={MEDIA,details,errors,messageType};
