'use strict';
const assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto'),{Readable}=require('node:stream');
module.exports=async({models,sessions,app,now})=>{
  const admin=await models.Usuario.create({id_usuario:1,nombre:'Administrador ficticio',email_usuario:'revocation-admin@example.invalid',password_usuario:'FICTITIOUS_ADMIN_HASH'});
  const token=(await sessions.authenticated(admin)).body.token;
  const {createRepository,drain}=require('../../../services/platformAudit.repository'),audit=createRepository(models.PlatformAuditEvent);
  const {createWriter,KEY_ARN}=require('../../../../services/platform-audit/src/s3'),versions=new Map();
  const s3={send:async command=>{
    const input=command.input;
    if(command.constructor.name==='PutObjectCommand'){
      assert(!versions.has(input.Key));const row={body:input.Body,VersionId:randomUUID(),ChecksumSHA256:input.ChecksumSHA256};versions.set(input.Key,row);
      return {...row,ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN};
    }
    assert.equal(command.constructor.name,'GetObjectCommand');const row=versions.get(input.Key);assert(row);assert.equal(input.VersionId,row.VersionId);
    return {ContentLength:Buffer.byteLength(row.body),ContentType:'application/json',VersionId:row.VersionId,ChecksumSHA256:row.ChecksumSHA256,ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN,Body:Readable.from([row.body])};
  }};
  const reader={read:input=>require('../../../../services/platform-audit/src/reader').readBatch({version:1,audience:'clinicaclick-audit-reader-v1',issuedAt:Date.now(),nonce:randomUUID(),...input},s3)};
  const view=require('../../../services/platformAudit.view').createView({model:models.PlatformAuditEvent,audit,reader,now,codec:require('../../../../services/platform-audit/src/view-contract').cursorCodec(randomBytes(32))});
  const read=async(userId,sessionRef)=>{
    await drain(audit,createWriter(s3),{limit:100,now});const date=now().toISOString().slice(0,10);
    return view.read({actorId:userId,sessionRef,query:{from:date,to:date,action:'integration.asset.disconnect'}});
  };
  app.get('/api/system-monitoring/audit/events',async(req,res)=>{
    try{const claims=await sessions.verify(require('../../../services/accessSession.service').bearer(req.headers.authorization));res.json(await read(claims.userId,claims.jti));}
    catch(error){res.status(error.status||503).json({error:error.code||'audit_unavailable'});}
  });
  return {token,async verify(userToken){
    const user=await sessions.verify(userToken);await assert.rejects(()=>read(user.userId,user.jti),{status:403});
    const actor=await sessions.verify(token),page=await read(actor.userId,actor.jti);
    const rows=page.events.filter(row=>row.metaRevocation);assert.equal(rows.length,6);assert(rows.every(row=>row.verification==='s3_version_verified'));
  }};
};
