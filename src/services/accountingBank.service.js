'use strict';
const crypto=require('node:crypto');
const {Op,Transaction,literal,where:sqlWhere}=require('sequelize');
const db=require('../../models');
const L=require('../lib/accountingBank');
const storage=require('./clinicalPrivateStorage.service');
const types=['expense','payment','payroll','refund'];
const plain=row=>row?.toJSON?row.toJSON():row;
const json=value=>typeof value==='string'?JSON.parse(value):value;
const sum=rows=>rows.reduce((total,row)=>total+L.cents(row.amount),0);
const status=(amount,matched)=>matched===0?'unmatched':matched>=amount?'matched':'partial';
const descriptor={
  expense:{model:'AccountingExpenseDocument',amount:'total',date:'issue_date',description:'supplier_name',direction:'outgoing'},
  payment:{model:'EconomicPayment',amount:'amount',date:'paid_at',description:'reference',direction:'incoming'},
  payroll:{model:'AccountingPayrollPeriod',amount:'net_paid',date:'period_month',description:'notes',direction:'outgoing'},
  refund:{model:'EconomicConceptAdjustment',amount:'refund_amount',date:'created_at',description:'reason',direction:'outgoing'},
};
function targetWhere(type) {
  if(type==='payment')return {status:'confirmed'};
  if(type==='expense')return {status:{[Op.ne]:'cancelled'}};
  if(type==='payroll')return {status:{[Op.in]:['scheduled','paid']}};
  return {refund_amount:{[Op.gt]:0},settlement:'refund'};
}
function modelId(type){return type==='refund'?'id':'public_id';}
function assertPayroll(type,includePayroll){if(type==='payroll'&&!includePayroll)throw L.error(403,'bank_payroll_forbidden','No tienes permiso para conciliar nóminas.');}
async function docsForPayments(clinicId,ids,transaction) {
  if(!ids.length)return new Map();
  const coverage=await db.EconomicFiscalCoverage.findAll({where:{clinic_id:clinicId,payment_id:{[Op.in]:ids},status:'issued',document_type:{[Op.in]:['invoice','receipt']}},transaction});
  const docs=await db.PatientFiscalDocument.findAll({where:{clinic_id:clinicId,status:'issued',document_type:{[Op.in]:['invoice','receipt']},[Op.or]:[{payment_id:{[Op.in]:ids}},...(coverage.length?[{id:{[Op.in]:coverage.map(r=>r.document_id)}}]:[])]},transaction});
  const map=new Map(ids.map(id=>[String(id),[]]));
  for(const doc of docs){
    const owners=new Set([...(doc.payment_id?[String(doc.payment_id)]:[]),...coverage.filter(r=>String(r.document_id)===String(doc.id)).map(r=>String(r.payment_id))]);
    for(const owner of owners)if(map.has(owner))map.get(owner).push({id:doc.public_id,number:doc.number,type:doc.document_type,status:doc.status});
  }
  return map;
}
function matchDto(row,lineVersion=null){const r=plain(row),snapshot=json(r.target_snapshot)||{};return {id:r.id,line_id:r.line_id,line_version:lineVersion,target_type:r.target_type,target_id:r.target_id,amount:Number(r.amount),status:r.status,created_at:r.created_at,reversed_at:r.reversed_at??null,reason:r.reason??null,reversal_reason:r.reversal_reason??null,documents:snapshot.documents??[]};}
async function lineDto(row,transaction,includePayroll=true){
  const r=plain(row),matches=await db.AccountingBankMatch.findAll({where:{clinic_id:r.clinic_id,line_id:r.id},order:[['created_at','ASC'],['id','ASC']],transaction});
  const payments=matches.some(m=>m.target_type==='payment')?await db.EconomicPayment.findAll({where:{clinic_id:r.clinic_id,public_id:{[Op.in]:matches.filter(m=>m.target_type==='payment').map(m=>m.target_id)}},attributes:['id','public_id'],transaction}):[];
  const documents=await docsForPayments(r.clinic_id,payments.map(p=>p.id),transaction),paymentDocs=new Map(payments.map(p=>[p.public_id,documents.get(String(p.id))??[]]));
  const matched=sum(matches.filter(m=>m.status==='active')),amount=L.cents(r.amount);
  return {id:r.id,import_id:r.import_id,account_ref:r.account_ref,date:r.date,description:r.description,currency:r.currency,direction:r.direction,amount:amount/100,version:Number(r.version),matched_amount:matched/100,remaining:Math.max(0,amount-matched)/100,status:status(amount,matched),matches:matches.map(m=>m.target_type==='payroll'&&!includePayroll?{id:m.id,line_id:m.line_id,line_version:Number(r.version),amount:Number(m.amount),status:m.status,target_type:'restricted',target_id:null,documents:[]}:{...matchDto(m,Number(r.version)),...(m.target_type==='payment'&&paymentDocs.has(m.target_id)?{documents:paymentDocs.get(m.target_id)}:{})})};
}
async function targetDto(type,row,transaction,documents=null){
  const r=plain(row),spec=descriptor[type],id=String(r[modelId(type)]),matches=await db.AccountingBankMatch.findAll({where:{clinic_id:r.clinic_id,target_type:type,target_id:id},order:[['created_at','ASC'],['id','ASC']],transaction});
  const matched=sum(matches.filter(m=>m.status==='active')),amount=L.cents(r[spec.amount]);
  if(documents===null)documents=type==='payment'?(await docsForPayments(r.clinic_id,[r.id],transaction)).get(String(r.id))??[]:[];
  if(type==='refund'){
    const notes=await db.PatientFiscalDocument.findAll({where:{clinic_id:r.clinic_id,patient_id:r.patient_id,status:'issued',document_type:'credit_note',[Op.and]:sqlWhere(literal("JSON_UNQUOTE(JSON_EXTRACT(`payment_data`, '$.adjustment_id'))"),r.id)},transaction});
    documents=notes.map(note=>({id:note.public_id,number:note.number,type:note.document_type,status:note.status}));
  }
  const requiresPayment=['expense','payroll'].includes(type)&&r.status!=='paid';
  return {id,type,source_status:r.status??'confirmed',can_match:!requiresPayment,required_action:requiresPayment?'register_payment':null,direction:spec.direction,currency:'EUR',date:r[spec.date],description:type==='expense'?`${r.supplier_name} · ${r.document_number}`:type==='payroll'?`Nóminas · ${r.period_month}`:type==='refund'?`Devolución · ${L.clean(r.reason,160)}`:`Cobro · ${L.clean(r.reference||r.public_id,160)}`,amount:amount/100,matched_amount:matched/100,remaining:Math.max(0,amount-matched)/100,status:status(amount,matched),documents,matches:matches.map(m=>matchDto(m))};
}
async function lockedTarget({clinicId,type,id,transaction,includePayroll}) {
  if(!types.includes(type))throw L.error(400,'bank_target_invalid','Selecciona un destino válido.');
  assertPayroll(type,includePayroll);
  if(typeof id!=='string'||!id||id.length>36||!/^[a-zA-Z0-9_-]+$/.test(id))throw L.error(400,'bank_target_invalid','Selecciona un destino válido.');
  const spec=descriptor[type],row=await db[spec.model].findOne({where:{clinic_id:clinicId,[modelId(type)]:id,...targetWhere(type)},transaction,lock:transaction.LOCK.UPDATE});
  if(!row||L.cents(row[spec.amount])<=0)throw L.error(404,'bank_target_not_found','El destino no está disponible en esta clínica.');
  return row;
}
function visibleResult(result,includePayroll){
  if(includePayroll)return result;
  const line=r=>({...r,matches:(r.matches??[]).map(m=>m.target_type==='payroll'?{id:m.id,line_id:m.line_id,line_version:m.line_version,amount:m.amount,status:m.status,target_type:'restricted',target_id:null,documents:[]}:m)});
  return {...result,...(result.line?{line:line(result.line)}:{}),...(Array.isArray(result.items)?{items:result.items.map(line)}:{})};
}
async function command({clinicId,actorId,payload,kind,lineId=null,matchId=null,includePayroll=false},work){
  const key=L.clean(payload.idempotency_key,120);
  if(typeof payload.idempotency_key!=='string'||!key||key!==String(payload.idempotency_key)||!/^[a-zA-Z0-9._:-]{8,120}$/.test(key))throw L.error(400,'bank_idempotency_key_required','La operación necesita una referencia de reintento.');
  const requestHash=L.hash({kind,lineId,matchId,payload});
  return db.sequelize.transaction({isolationLevel:Transaction.ISOLATION_LEVELS.READ_COMMITTED},async transaction=>{
    // One native clinic row serializes coverage across every line/import in the
    // clinic; source rows are then locked before reading their current amount.
    const clinic=await db.Clinica.findByPk(clinicId,{attributes:['id_clinica'],transaction,lock:transaction.LOCK.UPDATE});
    if(!clinic)throw L.error(404,'bank_clinic_not_found','Clínica no encontrada.');
    const old=await db.AccountingBankCommand.findOne({where:{clinic_id:clinicId,actor_id:actorId,idempotency_key:key},transaction});
    if(old){if(old.request_hash!==requestHash||old.command_type!==kind)throw L.error(409,'bank_idempotency_conflict','La referencia ya corresponde a otra operación.',{applied:false});return {...visibleResult(json(old.result),includePayroll),command:{idempotency_key:key,kind,applied:true},replayed:true};}
    try{
      const result={...await work(transaction),command:{idempotency_key:key,kind,applied:true}};
      await db.AccountingBankCommand.create({id:crypto.randomUUID(),clinic_id:clinicId,actor_id:actorId,idempotency_key:key,command_type:kind,request_hash:requestHash,result,created_at:new Date()},{transaction});
      return {...result,replayed:false};
    }catch(error){if(error.statusCode)error.details={...error.details,applied:false};throw error;}
  });
}
async function previewImport({clinicId,payload}){
  let parsed;
  try{parsed=L.parse(payload);}catch(error){
    if(error.code==='bank_csv_mapping_required'&&Array.isArray(error.details?.headers))return {headers:error.details.headers,row_count:error.details.row_count,items:[],errors:[{row:1,fields:['mapping']}],duplicate_count:0,new_count:0,can_confirm:false,warnings:[]};
    throw error;
  }
  const existing=await db.AccountingBankLine.findAll({where:{clinic_id:clinicId,account_ref:parsed.account_ref,row_key:{[Op.in]:parsed.items.map(r=>r.row_key)}},attributes:['row_key','date','description','amount','direction','currency']});
  const byKey=new Map(existing.map(r=>[r.row_key,r]));
  const conflicts=parsed.items.filter(r=>{const old=byKey.get(r.row_key);return old&&(['date','description','direction','currency'].some(k=>String(old[k])!==String(r[k]))||L.cents(old.amount)!==L.cents(r.amount));});
  return {account_ref:parsed.account_ref,currency:parsed.currency,configuration:parsed.configuration,headers:parsed.headers,row_count:parsed.row_count,items:parsed.items.map(({row_key,...r})=>({...r,duplicate:byKey.has(row_key)})),errors:[...parsed.errors,...conflicts.map(r=>({row:r.source_row,fields:['transaction_id_conflict']}))],duplicate_count:existing.length,new_count:parsed.items.length-existing.length,can_confirm:parsed.can_confirm&&!conflicts.length,warnings:parsed.warnings};
}
async function createImport(input){
  const parsed=L.parse(input.payload);if(!parsed.can_confirm)throw L.error(400,'bank_csv_review_required','Corrige las filas del extracto antes de importarlo.',{errors:parsed.errors});
  let asset;
  try{return await command({...input,kind:'import'},async transaction=>{
    const old=await db.AccountingBankImport.findOne({where:{clinic_id:input.clinicId,account_ref:parsed.account_ref,content_hash:parsed.content_hash},transaction});
    if(old){if(L.hash(json(old.configuration))!==L.hash(parsed.configuration)||old.currency!==parsed.currency)throw L.error(409,'bank_import_configuration_conflict','Este original ya se importó con otro formato o moneda.');return {import:plain(old),items:[],duplicate:true};}
    const id=crypto.randomUUID(),now=new Date(),created=[],duplicates=[];
    // Check overlapping originals before persisting any object or line.
    for(const row of parsed.items){const oldLine=await db.AccountingBankLine.findOne({where:{clinic_id:input.clinicId,account_ref:parsed.account_ref,row_key:row.row_key},transaction});if(oldLine){if(['date','description','direction','currency'].some(k=>String(oldLine[k])!==String(row[k]))||L.cents(oldLine.amount)!==L.cents(row.amount))throw L.error(409,'bank_transaction_identity_conflict','Un identificador bancario ya contiene otro movimiento.');duplicates.push({...row,id:oldLine.id});}else created.push({...row,id:crypto.randomUUID()});}
    asset=await storage.storeClinicalPrivateAsset({purpose:'accounting_bank_statement',contentType:'text/csv',buffer:parsed.buffer,clinicId:input.clinicId,ownerType:'accounting_bank_import',ownerId:id,originalFilename:L.clean(input.payload.filename,180)||'extracto.csv',createdBy:input.actorId,transaction});
    const head=await db.AccountingBankImport.create({id,clinic_id:input.clinicId,account_ref:parsed.account_ref,content_hash:parsed.content_hash,configuration:parsed.configuration,source_line_ids:[...created,...duplicates].sort((a,b)=>a.source_row-b.source_row).map(row=>row.id),source_asset_id:asset.id,currency:parsed.currency,row_count:parsed.row_count,created_count:created.length,duplicate_count:duplicates.length,created_by:input.actorId,created_at:now},{transaction});
    const items=[];for(const row of created){const line=await db.AccountingBankLine.create({...row,clinic_id:input.clinicId,import_id:id,account_ref:parsed.account_ref,version:1,created_at:now,updated_at:now},{transaction});items.push(await lineDto(line,transaction,input.includePayroll));}
    return {import:plain(head),items,duplicate:false,warnings:parsed.warnings};
  });}catch(error){if(asset)await storage.discardUncommittedClinicalObject(asset);throw error;}
}
function filters(query,kind,includePayroll){
  const q=L.clean(query.q,100),from=query.from?String(query.from):null,to=query.to?String(query.to):null;
  for(const value of [from,to])if(value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(new Date(value+'T00:00Z').getTime())||new Date(value+'T00:00Z').toISOString().slice(0,10)!==value))throw L.error(400,'bank_period_invalid','Indica fechas válidas.');
  if(from&&to&&from>to)throw L.error(400,'bank_period_invalid','El periodo no es válido.');
  for(const field of ['import_id','target_id','fiscal_document_id'])if(query[field]!==undefined&&(typeof query[field]!=='string'||!/^[a-zA-Z0-9_-]{1,36}$/.test(query[field])))throw L.error(400,'bank_filter_invalid','El identificador del filtro no es válido.');
  if(query.direction&&!['incoming','outgoing'].includes(query.direction))throw L.error(400,'bank_direction_invalid','Selecciona entradas o salidas.');
  return {kind,q,from,to,direction:query.direction??null,account_ref:query.account_ref?L.clean(query.account_ref,80):null,import_id:query.import_id??null,target_type:query.target_type??null,target_id:query.target_id??null,fiscal_document_id:query.fiscal_document_id??null,includePayroll};
}
function dated(where,field,scope){if(scope.from||scope.to)where[field]={...(scope.from?{[Op.gte]:scope.from}:{}),...(scope.to?{[Op.lt]:new Date(new Date(`${scope.to}T00:00:00Z`).getTime()+86400000).toISOString().slice(0,10)}: {})};return where;}
async function listLines({clinicId,query={},includePayroll=false}){
  const scope={clinicId,...filters(query,'lines',includePayroll)},after=L.cursor(query.cursor,scope),limit=L.limit(query.limit),where={clinic_id:clinicId};
  if(scope.import_id){const head=await db.AccountingBankImport.findOne({where:{id:scope.import_id,clinic_id:clinicId}});if(!head)throw L.error(404,'bank_import_not_found','Extracto no encontrado.');where.id={[Op.in]:json(head.source_line_ids)};}
  if(after)where.id={...where.id,[Op.gt]:after};if(scope.direction)where.direction=scope.direction;if(scope.account_ref)where.account_ref=scope.account_ref;if(scope.q)where.description={[Op.like]:`%${scope.q}%`};dated(where,'date',scope);
  const rows=await db.AccountingBankLine.findAll({where,order:[['id','ASC']],limit:limit+1}),items=[];
  for(const row of rows.slice(0,limit))items.push(await lineDto(row,null,includePayroll));
  return {items,next_cursor:rows.length>limit?L.nextCursor(rows[limit-1].id,scope):null};
}
async function listImports({clinicId,query={}}){
  const scope={clinicId,...filters(query,'imports',false)},after=L.cursor(query.cursor,scope),limit=L.limit(query.limit);
  const clauses=['i.clinic_id=:clinicId'],replacements={clinicId,limit:limit+1};
  if(scope.q){clauses.push('(i.account_ref LIKE :q OR a.original_filename LIKE :q)');replacements.q=`%${scope.q}%`;}
  if(scope.account_ref){clauses.push('i.account_ref=:account');replacements.account=scope.account_ref;}
  if(scope.import_id){clauses.push('i.id=:importId');replacements.importId=scope.import_id;}
  if(scope.from){clauses.push('i.created_at >= :from');replacements.from=scope.from;}
  if(scope.to){clauses.push('i.created_at < :to');replacements.to=new Date(new Date(scope.to+'T00:00Z').getTime()+86400000);}
  if(after){
    if(!/^\d{13}-[a-zA-Z0-9-]{1,36}$/.test(after))throw L.error(400,'bank_cursor_invalid','La página del historial no es válida.');
    const date=new Date(Number(after.slice(0,13)));if(Number.isNaN(date.getTime()))throw L.error(400,'bank_cursor_invalid','La página del historial no es válida.');
    clauses.push('(i.created_at < :afterDate OR (i.created_at = :afterDate AND i.id < :afterId))');replacements.afterDate=date;replacements.afterId=after.slice(14);
  }
  const [rows]=await db.sequelize.query(`SELECT i.id,a.original_filename AS filename,i.account_ref,i.currency,i.row_count,i.created_count,i.duplicate_count,i.created_at
    FROM AccountingBankImports i JOIN ClinicalPrivateAssets a ON a.id=i.source_asset_id AND a.clinic_id=i.clinic_id AND a.purpose='accounting_bank_statement'
    WHERE ${clauses.join(' AND ')} ORDER BY i.created_at DESC,i.id DESC LIMIT :limit`,{replacements});
  const items=rows.slice(0,limit).map(r=>({...r,row_count:Number(r.row_count),created_count:Number(r.created_count),duplicate_count:Number(r.duplicate_count)})),last=items.at(-1);
  return {items,next_cursor:rows.length>limit?L.nextCursor(`${String(new Date(last.created_at).getTime()).padStart(13,'0')}-${last.id}`,scope):null};
}
async function listTargets({clinicId,query={},includePayroll=false}){
  const scope={clinicId,...filters(query,'targets',includePayroll)},after=L.cursor(query.cursor,scope),limit=L.limit(query.limit),items=[];
  if(scope.target_type&&!types.includes(scope.target_type))throw L.error(400,'bank_target_invalid','Selecciona un destino válido.');
  if(scope.target_type)assertPayroll(scope.target_type,includePayroll);
  let paymentIds=null,refundIds=null,review=false,reason=null;
  if(scope.fiscal_document_id){
    const doc=await db.PatientFiscalDocument.findOne({where:{clinic_id:clinicId,public_id:scope.fiscal_document_id,status:'issued'}});
    if(!doc)throw L.error(404,'bank_document_not_found','Documento emitido no encontrado.');
    if(doc.document_type==='credit_note'){
      const adjustmentId=json(doc.payment_data)?.adjustment_id;
      const adjustment=typeof adjustmentId==='string'?await db.EconomicConceptAdjustment.findOne({where:{clinic_id:clinicId,patient_id:doc.patient_id,id:adjustmentId}}):null;
      refundIds=adjustment&&adjustment.settlement==='refund'&&Number(adjustment.refund_amount)>0?[adjustment.id]:[];
      review=!adjustment;reason=review?'fiscal_refund_requires_review':refundIds.length?null:'fiscal_document_has_no_recorded_refund';
    }else{
      const coverage=await db.EconomicFiscalCoverage.findAll({where:{clinic_id:clinicId,document_id:doc.id,status:'issued'}});
      paymentIds=[...new Set([...(doc.payment_id?[Number(doc.payment_id)]:[]),...coverage.filter(r=>r.payment_id).map(r=>Number(r.payment_id))])];
      review=coverage.some(r=>!r.payment_id)||!paymentIds.length;reason=review?'fiscal_funding_requires_review':null;
    }
  }
  for(const type of types){
    if(type==='payroll'&&!includePayroll||scope.target_type&&scope.target_type!==type||scope.direction&&descriptor[type].direction!==scope.direction||paymentIds!==null&&type!=='payment'||refundIds!==null&&type!=='refund')continue;
    if(after&&type<after.split('-')[0])continue;
    const spec=descriptor[type],where={clinic_id:clinicId,...targetWhere(type)};
    if(type!=='refund')where[spec.amount]={[Op.gt]:0};
    if(scope.target_id)where[modelId(type)]=scope.target_id;
    if(paymentIds!==null)where.id={[Op.in]:paymentIds};
    if(refundIds!==null)where.id={[Op.in]:refundIds};
    if(after?.startsWith(`${type}-`))where[modelId(type)]={...(where[modelId(type)]?{[Op.eq]:where[modelId(type)]}:{}),[Op.gt]:after.slice(type.length+1)};
    if(scope.q)where[Op.or]=[{[spec.description]:{[Op.like]:`%${scope.q}%`}},...(type==='expense'?[{document_number:{[Op.like]:`%${scope.q}%`}}]:[])];
    dated(where,spec.date,scope);
    const rows=await db[spec.model].findAll({where,order:[[modelId(type),'ASC']],limit:limit+1-items.length});
    const docs=type==='payment'?await docsForPayments(clinicId,rows.map(r=>r.id)):null;
    for(const row of rows)items.push(await targetDto(type,row,null,type==='payment'?docs.get(String(row.id))??[]:[]));
    if(items.length>limit)break;
  }
  const page=items.slice(0,limit),last=page.at(-1);
  return {items:page,next_cursor:items.length>limit?L.nextCursor(`${last.type}-${last.id}`,scope):null,review_required:review,reason};
}
async function createMatches(input){return command({...input,kind:'match'},async transaction=>{
  const line=await db.AccountingBankLine.findOne({where:{id:input.lineId,clinic_id:input.clinicId},transaction,lock:transaction.LOCK.UPDATE});
  if(!line)throw L.error(404,'bank_line_not_found','Movimiento no encontrado.');
  if(!Number.isInteger(input.payload.expected_version)||input.payload.expected_version!==Number(line.version))throw L.error(409,'bank_line_version_conflict','El movimiento ha cambiado. Actualiza antes de conciliar.',{version:Number(line.version)});
  const allocations=input.payload.allocations;
  if(!Array.isArray(allocations)||!allocations.length||allocations.length>50)throw L.error(400,'bank_allocations_required','Selecciona entre 1 y 50 destinos.');
  if(new Set(allocations.map(a=>`${a.target_type}:${a.target_id}`)).size!==allocations.length)throw L.error(400,'bank_target_duplicate','Un destino sólo puede aparecer una vez.');
  const current=await db.AccountingBankMatch.findAll({where:{clinic_id:input.clinicId,line_id:line.id,status:'active'},transaction}),remaining=L.cents(line.amount)-sum(current);
  let total=0;const prepared=[];
  for(const allocation of [...allocations].sort((a,b)=>`${a.target_type}:${a.target_id}`.localeCompare(`${b.target_type}:${b.target_id}`))){
    const amount=L.cents(allocation.amount);if(amount<=0)throw L.error(400,'bank_amount_invalid','El importe conciliado debe ser positivo.');
    const row=await lockedTarget({clinicId:input.clinicId,type:allocation.target_type,id:allocation.target_id,includePayroll:input.includePayroll,transaction});
    const target=await targetDto(allocation.target_type,row,transaction);
    if(!target.can_match)throw L.error(409,'bank_target_payment_required','Registra el pago de este documento antes de conciliarlo.',{target_id:target.id,required_action:'register_payment'});
    if(line.currency!==target.currency)throw L.error(409,'bank_currency_mismatch','La moneda del movimiento y del destino no coincide.');
    if(line.direction!==target.direction)throw L.error(409,'bank_direction_mismatch','Las entradas y las salidas se concilian por separado.');
    if(amount>L.cents(target.remaining))throw L.error(409,'bank_target_overcovered','Parte del destino ya está conciliada.',{target_id:target.id,remaining:target.remaining});
    total+=amount;prepared.push({allocation,amount,target});
  }
  if(total>remaining)throw L.error(409,'bank_line_overcovered','El importe supera el saldo del movimiento.',{remaining:Math.max(0,remaining)/100});
  const now=new Date();for(const p of prepared){const {matches,...snapshot}=p.target;await db.AccountingBankMatch.create({id:crypto.randomUUID(),clinic_id:input.clinicId,line_id:line.id,target_type:p.allocation.target_type,target_id:p.target.id,amount:p.amount/100,target_snapshot:snapshot,status:'active',reason:L.clean(input.payload.reason,500)||null,created_by:input.actorId,created_at:now},{transaction});}
  await line.update({version:Number(line.version)+1,updated_at:now},{transaction});
  return {line:await lineDto(line,transaction,input.includePayroll)};
});}
async function reverseMatch(input){return command({...input,kind:'reverse'},async transaction=>{
  const match=await db.AccountingBankMatch.findOne({where:{id:input.matchId,clinic_id:input.clinicId},transaction});
  if(!match)throw L.error(404,'bank_match_not_found','Conciliación no encontrada.');assertPayroll(match.target_type,input.includePayroll);
  const line=await db.AccountingBankLine.findOne({where:{id:match.line_id,clinic_id:input.clinicId},transaction,lock:transaction.LOCK.UPDATE});
  if(!Number.isInteger(input.payload.expected_version)||input.payload.expected_version!==Number(line.version))throw L.error(409,'bank_line_version_conflict','El movimiento ha cambiado.',{version:Number(line.version)});
  if(match.status!=='active')throw L.error(409,'bank_match_already_reversed','La conciliación ya se deshizo.');
  const reason=L.clean(input.payload.reason,500);if(!reason)throw L.error(400,'bank_reversal_reason_required','Indica el motivo para deshacer la conciliación.');
  const now=new Date();await match.update({status:'reversed',reversed_by:input.actorId,reversed_at:now,reversal_reason:reason},{transaction});
  await line.update({version:Number(line.version)+1,updated_at:now},{transaction});return {line:await lineDto(line,transaction,input.includePayroll)};
});}
async function assertTargetEditable({clinicId,type,id,transaction}){
  if(!db.AccountingBankMatch)return;
  const count=await db.AccountingBankMatch.count({where:{clinic_id:clinicId,target_type:type,target_id:id,status:'active'},transaction});
  if(count)throw L.error(409,'bank_reconciliation_target_locked','Este registro tiene una conciliación activa. Deshaz el vínculo bancario antes de cambiarlo.');
}
async function source({clinicId,id}){
  const head=await db.AccountingBankImport.findOne({where:{id,clinic_id:clinicId}});if(!head)throw L.error(404,'bank_import_not_found','Extracto no encontrado.');
  const asset=await db.ClinicalPrivateAsset.findOne({where:{id:head.source_asset_id,clinic_id:clinicId,purpose:'accounting_bank_statement',status:'active'}});if(!asset)throw L.error(404,'bank_import_not_found','Extracto no encontrado.');return storage.readClinicalPrivateAsset(asset);
}
async function workspace(input){
  const lines=await listLines(input),scope=filters(input.query??{},'lines',input.includePayroll);
  // Aggregate the entire requested scope, independently of its current page.
  const clauses=['l.clinic_id = :clinicId'],replacements={clinicId:input.clinicId};
  if(scope.from){clauses.push('l.date >= :from');replacements.from=scope.from;}
  if(scope.to){clauses.push('l.date <= :to');replacements.to=scope.to;}
  if(scope.q){clauses.push('l.description LIKE :q');replacements.q=`%${scope.q}%`;}
  if(scope.direction){clauses.push('l.direction = :direction');replacements.direction=scope.direction;}
  if(scope.account_ref){clauses.push('l.account_ref = :account');replacements.account=scope.account_ref;}
  if(scope.import_id){const head=await db.AccountingBankImport.findOne({where:{id:scope.import_id,clinic_id:input.clinicId}});if(!head)throw L.error(404,'bank_import_not_found','Extracto no encontrado.');const ids=json(head.source_line_ids);clauses.push(ids.length?'l.id IN (:importLines)':'1=0');replacements.importLines=ids;}
  const [summary]=await db.sequelize.query(`SELECT l.currency,l.direction,COUNT(*) AS line_count,SUM(l.amount) AS amount,
    SUM(COALESCE(m.amount,0)) AS matched_amount FROM AccountingBankLines l LEFT JOIN
    (SELECT line_id,clinic_id,SUM(amount) AS amount FROM AccountingBankMatches WHERE status='active' GROUP BY line_id,clinic_id) m
    ON m.line_id=l.id AND m.clinic_id=l.clinic_id WHERE ${clauses.join(' AND ')} GROUP BY l.currency,l.direction`,{replacements});
  return {...lines,summary:summary.map(r=>({...r,line_count:Number(r.line_count),amount:L.aggregateCents(r.amount)/100,matched_amount:L.aggregateCents(r.matched_amount)/100,remaining:(L.aggregateCents(r.amount)-L.aggregateCents(r.matched_amount))/100})),currency:new Set(summary.map(r=>r.currency)).size===1?summary[0].currency:null,ledger_currency:'EUR',reconciliation_changes_money:false};
}
module.exports={previewImport,createImport,listLines,listImports,listTargets,createMatches,reverseMatch,assertTargetEditable,source,workspace,__testing:{targetDto,lineDto}};
