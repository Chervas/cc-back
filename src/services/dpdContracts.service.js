'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {Op} = require('sequelize');
const db = require('../../models');
const {createWorkspace} = require('./dpdWorkspace.service');
const logo = fs.readFileSync(path.join(__dirname,'../contracts/dpd/logo.png')).toString('base64');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const hours48 = 48*3600000;
const acceptance = 'He leído el contrato y sus anexos. Declaro que tengo facultades para representar a la entidad indicada y acepto firmar electrónicamente este documento.';
function fail(status,message){throw Object.assign(new Error(message),{status});}
function field(value,label,max=240){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))fail(400,'Revisa '+label+'.');return value.trim();}
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function documentHtml(blocks){
  const content=blocks.map((b,i)=>'<'+(i?'h2':'h1')+'>'+esc(b.title)+'</'+(i?'h2':'h1')+'>'+b.text.split(/\n\s*\n/).map(p=>{
    if(!p.startsWith('|'))return '<p>'+esc(p)+'</p>';
    return '<table>'+p.split('\n').filter(l=>!/^\|[ |:-]+\|$/.test(l)).map((l,n)=>'<tr>'+l.replace(/^\||\|$/g,'').split(' | ').map(c=>n?'<td>'+esc(c.trim())+'</td>':'<th>'+esc(c.trim())+'</th>').join('')+'</tr>').join('')+'</table>';
  }).join('')).join('');
  return content;
}
function sheet(body){return '<!doctype html><html lang="es"><meta charset="utf-8"><style>@page{size:A4;margin:18mm 16mm}body{font:10pt/1.5 Arial,sans-serif;color:#182c44}header{border-top:3px solid #159aca;padding:10px 0 16px}header img{width:130px}h1,h2{color:#123552;break-after:avoid}h1{font-size:21pt}h2{font-size:13pt;border-bottom:1px solid #cddfe7;padding-bottom:4px}p{white-space:pre-line}table{border-collapse:collapse;width:100%;font-size:8pt}th,td{padding:5px;text-align:left;border:1px solid #ccdae3}th{background:#edf6fc}tr{break-inside:avoid}.proof{break-before:page;overflow-wrap:anywhere}.signature{max-width:170px;max-height:90px}</style><header><img alt="Clínica Click" src="data:image/png;base64,'+logo+'"></header>'+body+'</html>';}
const publicFields=['clinica','nif','domicilio','nombre','cargo'];
function personalize(d, input) {
  const v=Object.fromEntries(publicFields.map(k=>[k,field(input[k],k)]));
  const extra=input.entidades?field(input.entidades,'entidades representadas',1500):'';
  const fecha=new Intl.DateTimeFormat('es-ES',{dateStyle:'long',timeZone:'Europe/Madrid'}).format(new Date());
  const fields={...v,representante:v.nombre+', en calidad de '+v.cargo,fecha};
  const blocks=d.model.map(b=>({title:b.title,text:b.text.replace(/\{\{(\w+)\}\}/g,(_,k)=>fields[k]??fail(400,'Campo sin completar: '+k))}));
  blocks.push({title:'Ámbito del contrato',text:'Centro o grupo: '+d.target+'. Centros incluidos: '+d.centres.join(', ')+'. Entidad representada: '+v.clinica+' ('+v.nif+').'+(extra?' Otras entidades representadas: '+extra+'.':'')});
  return {inputs:{...v,entidades:extra},blocks,hash:hash(JSON.stringify(blocks.map(({title,text})=>[title,text])))};
}
function emailAddress(value){const address=field(value,'correo',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))fail(400,'Correo no válido.');return address;}
function token(){const key=crypto.randomBytes(32).toString('base64url');return {key,secret_hash:hash(key),expires:new Date(Date.now()+hours48)};}
const unavailable='Por seguridad, el enlace ha caducado o se ha sustituido. Solicita uno nuevo a tu proveedor.';
function check(r,key){if(!r||!key||r.secret_hash!==hash(key)||+new Date(r.expires)<=Date.now())fail(410,unavailable);}
function state(r){return {id:r.id,target:r.target,email:r.email,status:['pendiente','revisado'].includes(r.status)&&+new Date(r.expires)<=Date.now()?'caducado':r.status,expires:r.expires,issued:r.issued};}
async function targets(q){
 const opts={where:{},limit:30,raw:true};
 const [clinics,groups]=await Promise.all([[db.Clinica,'id_clinica','nombre_clinica'],[db.GrupoClinica,'id_grupo','nombre_grupo']].map(([model,id,name])=>model.findAll({...opts,where:{[name]:{[Op.like]:'%'+field(q,'búsqueda',150)+'%'}},attributes:[[id,'id'],[name,'name']],order:[[name,'ASC']]})));
 return [...clinics.map(r=>({...r,type:'clinica'})),...groups.map(r=>({...r,type:'grupo'}))];
}
async function signatureImage(uri) {
  if(typeof uri!=='string'||uri.length>190000||!/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(uri))fail(400,'Adjunta la firma de La Voz en PNG o JPG.');
  try{return await require('sharp')(Buffer.from(uri.split(',')[1],'base64'),{limitInputPixels:8000000}).resize({width:500,withoutEnlargement:true}).png().toBuffer();}
  catch{fail(400,'Imagen de firma no válida.');}
}
async function issue(b,actor){
 const group=b.type==='grupo';if(!group&&b.type!=='clinica')fail(400,'Elige una clínica o grupo.');
 const target=await (group?db.GrupoClinica:db.Clinica).findByPk(b.targetId);if(!target)fail(404,'Centro no encontrado.');
 const name=group?target.nombre_grupo:target.nombre_clinica;
 const centres=group?(await db.Clinica.findAll({where:{grupoClinicaId:target.id_grupo},attributes:['nombre_clinica'],order:[['nombre_clinica','ASC']]})).map(r=>r.nombre_clinica):[name];
 if(!centres.length)fail(400,'El grupo no tiene centros.');
 const email=b.clientEmail===true?'':emailAddress(b.email);
 const w=await createWorkspace(db.DpdWorkspaceEntry).read(true);
 const model=(w.changes.contract?.value||w.blocks).map(block=>({...block,text:block.text.replace(/\{\{(\w+)\}\}/g,(tag,k)=>{
   const f=w.fields.find(v=>v.key===k); if(f?.scope==='cliente')return tag;
   const value=w.changes['field-'+k]?.value;if(typeof value!=='string'||!value.trim())fail(400,'Completa en Datos comunes: '+(f?.label||k));return value;
 })}));
 if(b.accept!==true)fail(400,'Confirma la firma de La Voz para esta oferta.');
 const signature=await signatureImage(b.image);
 const issued=new Date(), t=token(),id=crypto.randomUUID();
 const supplier={actor,name:w.changes['field-firmante']?.value,at:issued.toISOString(),method:'Aceptación expresa de la oferta desde cuenta administrativa autenticada',declaration:'Autorizo este modelo para el centro o grupo indicado y su cumplimentación por el representante designado.',digest:hash(JSON.stringify({model,target:name,centres,email})),imageHash:hash(signature)};
 const fiscal=target.datos_fiscales_clinica||{};
 const initial={clinica:b.legalName?field(b.legalName,'razón social'):fiscal.denominacion_social||fiscal.razon_social||'',nif:fiscal.cif_nif||fiscal.nif||'',domicilio:fiscal.direccion_facturacion||''};
 const row=await db.DpdContract.create({id,target:name,email,status:'pendiente',issued,expires:t.expires,secret_hash:t.secret_hash,dossier:{clientEmail:b.clientEmail===true,origin:['https://crm.clinicaclick.com','http://localhost:4203'].includes(b.origin)?b.origin:'https://crm.clinicaclick.com',model,target:name,centres,initial,actor,supplier,image:signature.toString('base64'),issuer:w.changes['field-firmante']?.value,history:[{action:'emitido',actor,at:issued.toISOString()}]}},{logging:false});
 return {...state(row),key:t.key};
}
async function operate(id,action,b,actor){
 if(!/^[0-9a-f-]{36}$/.test(id))fail(404,'Contrato no encontrado.');
 const result=await db.sequelize.transaction(async transaction=>{
 const row=await db.DpdContract.findByPk(id,{transaction,lock:transaction.LOCK.UPDATE,attributes:{exclude:['pdf']},logging:false});
 if(!actor)check(row,b.key);
 if(!row)fail(404,'Contrato no encontrado.');
 const d=structuredClone(row.dossier);
 const update=(fields)=>row.update({...fields,dossier:{...d}}, {transaction,logging:false});
 if(action==='view')return {...state(row),canSetEmail:d.clientEmail&&!d.lastSend,initial:d.snapshot?.inputs||d.initial,centres:d.centres,blocks:d.snapshot?.blocks||[],digest:d.snapshot?.hash,acceptance};
 if(action==='regenerate'){
  if(!['pendiente','revisado'].includes(row.status))fail(409,'El representante ya ha firmado.');
  const t=token();delete d.code;d.sends=0;d.history.push({action:'renovado',actor,at:new Date().toISOString()});
  await update({secret_hash:t.secret_hash,expires:t.expires});return {...state(row),key:t.key};
 }
 if(action==='review'){
  if(!['pendiente','revisado'].includes(row.status))fail(409,'La firma ya está registrada.');
  const email=d.clientEmail&&!d.lastSend?emailAddress(b.email):row.email;
  d.snapshot=personalize(d,b);delete d.code;await update({status:'revisado',email});return {blocks:d.snapshot.blocks,digest:d.snapshot.hash,acceptance};
 }
 if(action==='code'||action==='sign'){
  if(row.status!=='revisado'||b.digest!==d.snapshot?.hash)fail(409,'Revisa de nuevo el contrato.');
  if(action==='code'){
    if(Date.now()-(d.lastSend||0)<60000||(d.sends||0)>=12)fail(429,'Límite de códigos. Espera antes de solicitar otro o contacta con tu proveedor.');
    const code=String(crypto.randomInt(1000000)).padStart(6,'0');d.lastSend=Date.now();d.sends=(d.sends||0)+1;
    d.code={hash:hash(b.key+d.snapshot.hash+code),until:Date.now()+600000,tries:0};
    const queued=await require('./emailDelivery.service').queueEmail({stream:'transactional',relatedType:'dpd_contract',relatedId:id,templateKey:'dpd.signature_code',recipientEmail:row.email,dedupeKey:'dpd:'+id+':'+d.sends,templateContext:{verification_code:code},origin:'dpd.signature',priority:'critical'},{transaction});
    if(!queued?.emailMessage?.id||['suppressed','failed','cancelled','rejected'].includes(queued.emailMessage.status))fail(503,'No se pudo encolar el código.');
    d.code.message=queued.emailMessage.id;await update({});return {ok:true};
  }
  if(b.accept!==true||!d.code||d.code.until<=Date.now()||d.code.tries>=5)fail(400,'Solicita un código vigente y acepta el contrato.');
  if(!/^\d{6}$/.test(b.code)||d.code.hash!==hash(b.key+d.snapshot.hash+b.code)){
    d.code.tries++;await update({});return {invalid:true};
  }
  d.client={at:new Date().toISOString(),name:d.snapshot.inputs.nombre,role:d.snapshot.inputs.cargo,email:row.email,digest:d.snapshot.hash,method:'Código de un solo uso por correo',declaration:acceptance};delete d.code;
  const bytes=Buffer.from(d.image,'base64');
  const evidence=[['Por la clínica',d.client],['Por La Voz Medios Digitales, S.L.',d.supplier]].map(([label,s])=>'<h2>'+label+'</h2><p>'+[s.name,s.role,s.email,s.at,s.method,s.declaration,'SHA-256: '+s.digest].filter(Boolean).map(esc).join('<br>')+'</p>').join('');
  const html=sheet(documentHtml(d.snapshot.blocks)+'<section class="proof"><h1>Justificante de firmas</h1><p>Referencia '+id+'<br>SHA-256 del texto aceptado: '+d.snapshot.hash+'</p>'+evidence+'<img class="signature" src="data:image/png;base64,'+bytes.toString('base64')+'"></section>');
  const pdf=await require('./economicDocumentPdf.service').renderDocumentHtml(html);d.pdfHash=hash(pdf);
  const receipt=token();d.receipt={hash:receipt.secret_hash,until:receipt.expires.toISOString()};delete d.image;
  await update({status:'firmado',pdf});
  const base=d.origin;
  if(!base)fail(503,'Falta configurar la dirección pública para la copia por correo.');
  const url=new URL('/dpd/firmar',base);url.hash=new URLSearchParams({id,recibo:receipt.key}).toString();
  const mail=await require('./emailDelivery.service').queueEmail({stream:'transactional',relatedType:'dpd_contract',relatedId:id,templateKey:'dpd.signed_copy',recipientEmail:row.email,dedupeKey:'dpd:copy:'+id,templateContext:{reset_url:url.href},origin:'dpd.signature'},{transaction});
  if(!mail?.emailMessage?.id||['failed','suppressed','cancelled','rejected'].includes(mail.emailMessage.status))fail(503,'No se pudo preparar el envío de la copia. Vuelve a intentarlo.');
  d.receipt.message=mail.emailMessage.id;await update({});return {...state(row),receiptKey:receipt.key};
 }
 fail(400,'Operación desconocida.');
 });
 if(result.invalid)fail(400,'Código incorrecto.');return result;
}
module.exports={issue,operate,targets,state,check,hash,documentHtml,sheet,acceptance};
