'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {DataTypes,QueryTypes}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models})=>{
 for(const [migration,name,file] of [['20261120090000-create-dpd-workspace','DpdWorkspaceEntry','dpdworkspaceentry'],['20261126121500-create-dpd-contracts','DpdContract','dpdcontract']]){
  await require('../../../migrations/'+migration).up(sql.getQueryInterface(),DataTypes);models[name]=require('../../../models/'+file)(sql,DataTypes);
 }
 const schema=await require('../../lib/securitySchemaContract').snapshot(q=>sql.query(q,{type:QueryTypes.SELECT}));
 const tab='DpdContracts',table=schema.tables.find(r=>r.TABLE_NAME===tab);
 const columns=schema.columns.filter(r=>r.TABLE_NAME===tab).map(({TABLE_NAME,...c})=>c);
 const indexes=[...new Set(schema.indexes.filter(r=>r.TABLE_NAME===tab).map(r=>r.INDEX_NAME))].map(name=>({name,columns:schema.indexes.filter(r=>r.TABLE_NAME===tab&&r.INDEX_NAME===name).map(({TABLE_NAME,...r})=>r)}));
 const specification={ENGINE:table.ENGINE,TABLE_COLLATION:table.TABLE_COLLATION,columns,indexes,foreignKeys:[]};
 if(process.env.DPD_QA_SCHEMA_FILE)fs.writeFileSync(process.env.DPD_QA_SCHEMA_FILE,JSON.stringify(specification));
 const svc=require('../../services/dpdContracts.service'), ws=require('../../services/dpdWorkspace.service').createWorkspace(models.DpdWorkspaceEntry);
 models.GrupoClinica={findByPk:async()=>({nombre_grupo:'Grupo ficticio',id_grupo:10})};models.Clinica={findAll:async()=>[{nombre_clinica:'Uno'},{nombre_clinica:'Dos'}]};
 for(const f of (await ws.read(true)).fields.filter(f=>f.scope==='modelo'))await ws.save('field-'+f.key,{revision:0,value:'Valor de prueba'},1);
 const emailFile=require.resolve('../../services/emailDelivery.service');let otp,copy;
 require.cache[emailFile]={id:emailFile,loaded:true,exports:{queueEmail:async m=>{if(m.templateKey==='dpd.signature_code')otp=m.templateContext.verification_code;else copy=m.templateContext.reset_url;return {emailMessage:{id:1,status:'queued'}};}}};
 const image='data:image/png;base64,'+fs.readFileSync(require.resolve('../../contracts/dpd/logo.png')).toString('base64');
 const issued=await svc.issue({type:'grupo',targetId:10,email:'representante@example.invalid',image,accept:true},1);
 const {id}=issued;
 const saved=await models.DpdContract.findByPk(id);
 assert.ok(saved.dossier.signingKeyEnvelope && !saved.dossier.signingKeyEnvelope.includes(issued.key));
 const before=JSON.stringify(saved.dossier);
 for(let i=0;i<2;i++) {
  const copied=await svc.copyLink(id);assert.equal(copied.key,issued.key);assert.equal(+copied.expires,+saved.expires);
 }
 assert.equal(JSON.stringify((await saved.reload()).dossier),before);
 const legacy={...saved.dossier};delete legacy.signingKeyEnvelope;await saved.update({dossier:legacy});
 await assert.rejects(svc.copyLink(id),e=>e.status===409);
 assert.equal((await svc.operate(id,'view',{key:issued.key})).status,'pendiente');
 const renewed=await svc.operate(id,'regenerate',{},1);
 await assert.rejects(svc.operate(id,'view',{key:issued.key}),e=>e.status===410);
 const key=renewed.key;
 assert.equal((await svc.copyLink(id)).key,key);
 await saved.update({expires:new Date(0)});await assert.rejects(svc.copyLink(id),e=>e.status===410);
 await saved.update({expires:renewed.expires});
 const view=await svc.operate(id,'view',{key});assert.deepEqual(view.centres,['Uno','Dos']);
 const review=await svc.operate(id,'review',{key,clinica:'Sociedad de prueba',nif:'NIF de prueba',domicilio:'Dirección ficticia',nombre:'Persona de prueba',cargo:'Representante'});
 const digest=review.digest;await svc.operate(id,'code',{key,digest});
 await assert.rejects(svc.operate(id,'sign',{key,digest,code:'invalid',accept:true}),e=>e.status===400);
 const signed=await svc.operate(id,'sign',{key,digest,code:otp,accept:true});assert.equal(signed.status,'firmado');
 await assert.rejects(svc.copyLink(id),e=>e.status===409);
 const row=await models.DpdContract.findByPk(id);assert.equal(row.dossier.signingKeyEnvelope,undefined);assert.equal(row.dossier.receipt.message,1);assert.equal(row.dossier.pdfHash,svc.hash(row.pdf));assert.match(row.pdf.toString('ascii',0,5),/%PDF/);assert.ok(copy.includes('recibo='));
 await assert.rejects(svc.operate(id,'sign',{key,digest,code:otp,accept:true}),e=>e.status===409);
 await row.update({expires:new Date(0)});await assert.rejects(svc.operate(id,'view',{key}),e=>e.status===410);
 console.log('OK: contrato de grupo, sustitución, revisión, OTP, PDF, copia, repetición y caducidad');
}).catch(e=>{console.error(e.stack);process.exitCode=1;});
