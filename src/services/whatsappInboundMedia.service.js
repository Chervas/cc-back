'use strict';
// One dedicated fresh-inbound process owns this tick. Historical repair only
// restores content: it never bypasses dispatch cutoff, import holds or dedup.
async function tick(){
 const db=require('../../models'),broker=require('../lib/whatsappAuthorizedBrokerClient');
 if(!broker.configuration())return {processed:0};
 const [rows]=await db.sequelize.query(`SELECT m.id FROM Messages m JOIN Conversations c ON c.id=m.conversation_id
 WHERE c.channel='whatsapp' AND m.direction IN ('inbound','outbound') AND JSON_EXTRACT(m.metadata,'$.passive_recovery')=CAST('true' AS JSON)
 AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.media.kind'))='audio' AND JSON_CONTAINS_PATH(m.metadata,'one','$.media.id')
 AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.audio_transcription.status')),'') NOT IN ('success','unavailable')
 AND (JSON_EXTRACT(m.metadata,'$.media_retry_at') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.media_retry_at'))<=:now)
 ORDER BY (m.direction='inbound') DESC,m.id DESC LIMIT 3`,{replacements:{now:new Date().toISOString()}});
 let processed=0;
 for(const row of rows){let download;
  try{
   download=await broker.media(row.id);
   const result=await require('./groqAudio.service').transcribeAudioBuffer({buffer:download.buffer,mimeType:download.contentType,fileName:'whatsapp-audio.'+(download.contentType.includes('ogg')?'ogg':download.contentType.includes('mpeg')?'mp3':download.contentType.includes('mp4')?'m4a':download.contentType.split('/')[1])});
   await db.sequelize.transaction(async transaction=>{
    const m=await db.Message.findByPk(row.id,{transaction,lock:transaction.LOCK.UPDATE});
    const metadata={...m.metadata,audio_transcribed:true,resume_text:result.text,media_retry_at:null,
     audio_transcription:{status:'success',provider:result.provider,model:result.model,text:result.text,transcribed_at:new Date().toISOString()}};
    metadata.fresh_realtime_status='media_updated';
    await m.update({content:result.text,metadata},{transaction});
   });processed++;
  }catch{
   await db.sequelize.transaction(async transaction=>{
    const m=await db.Message.findByPk(row.id,{transaction,lock:transaction.LOCK.UPDATE});if(!m||m.metadata?.audio_transcribed)return;
    const attempts=Number(m.metadata?.media_attempts||0)+1;
    const metadata={...m.metadata,media_attempts:attempts,media_retry_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(attempts,6))).toISOString(),
      audio_transcription:{status:attempts>=5?'unavailable':'pending',reason:'audio_processing_unavailable'}};
    metadata.fresh_realtime_status='media_updated';
    await m.update({metadata},{transaction});
   });
  }finally{download?.buffer.fill(0);}
 }
 return {processed};
}
module.exports={tick};
