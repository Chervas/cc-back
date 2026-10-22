'use strict';
const { createHash } = require('node:crypto');
const { buildClinicCloudPatientHistory,dateOnly,plainText } = require('./cliniccloud-patient-history');
const parse = value => {try {return typeof value === 'string' ? JSON.parse(value) : value;} catch {return null;}};
const categoryFor = row => row.source_table === 'Paciente' ? 'profile' : row.source_table === 'Primera_Visita' ? 'prior_state'
  : row.source_table === 'Trabajo_Pendiente' ? 'pending_work' : ['Presupuestos','Presupuesto'].includes(row.source_table) ? 'budget'
  : row.source_table === 'Comentarios' ? 'comment' : ['Factura','Factura2','Recibo','Recibo2'].includes(row.source_table) ? 'economic'
  : row.source_table === 'Hist_Borr' ? 'deleted_history'
  : row.source_table === 'Historial' && (['COBR','0213'].includes(String(row.catalog?.code || '').trim().toUpperCase()) || ['C','A'].includes(String(row.record?.Tipolin))) ? 'economic' : 'historical';
function eurodentEnvelopes(fields) {
  return (Array.isArray(fields)?fields:[]).filter(field=>field?.source==='eurodent' && Number(field.clinica_id)>0)
    .map(field=>({field,envelope:parse(field.value)})).filter(({envelope:r})=>r?.version==='eurodent_source_record/1'
      && r.source_instance && r.source_table && r.record && !Array.isArray(r.record));
}
function buildExternalPatientHistory(fields,{clinics=[]}={}) {
  const clinicNames=new Map(clinics.map(c=>[Number(c.clinica_id ?? c.id_clinica),plainText(c.nombre_clinica)]));
  const entries=buildClinicCloudPatientHistory(fields,{clinics}).entries.map(entry=>({...entry,provider:'cliniccloud',category:entry.kind==='patient_profile'?'profile':'historical'}));
  for (const {field,envelope:r} of eurodentEnvelopes(fields)) {
    if (['Piezas','Piezas_pri','Factura2','Recibo2'].includes(r.source_table)) continue;
    const record=r.record, category=categoryFor(r), rawPiece=plainText(record.Pieza), title=plainText(r.catalog?.name)
      || plainText(record['Título']) || ({Paciente:'Ficha original del paciente',Presupuestos:'Presupuesto original',Factura:'Factura original',Recibo:'Recibo original',Hist_Borr:'Anotación eliminada en origen'}[r.source_table]) || 'Anotación original';
    const items=[];
    const add=(label,value)=>{value=plainText(value);if(value)items.push({label,value});};
    add('Tratamiento',r.catalog?.name);add('Código',r.catalog?.code);add('Familia en este registro',r.source_family?.name || r.catalog?.family_name);
    add('Pieza / alcance en origen',rawPiece);add('Observaciones',record.Obs);add('Observaciones de factura',record.Obs_fra);
    if (category==='profile') {add('Número de historia en origen',record['NºHist']);add('Alergias anotadas en origen',record.Alergias);add('Observaciones de ficha',record.Observaciones);}
    if (category==='comment')add('Contenido',record.Obs);
    if (['budget','economic','deleted_history'].includes(category)) {
      add('Documento en origen',record.Num);add('Importe original (€)',record.Precio_euro ?? record.Precio_Euro ?? record.total);
      if(category==='budget')add('Presupuesto de origen',record.IDPre);
    }
    let anatomy=null;
    try {anatomy=require('./eurodent-odontogram').normalizeEurodentDentalLocation(record,r.catalog||{});} catch(error) {if(error.code!=='MODULE_NOT_FOUND') throw error;}
    const id=createHash('sha256').update(`${field.clinica_id}:${r.source_instance}:${r.source_database}:${r.source_table}:${JSON.stringify(r.source_pk??r.source_ordinal)}`).digest('hex').slice(0,24);
    entries.push({id,provider:'eurodent',source:'Eurodent',kind:category==='profile'?'patient_profile':'clinical_note',category,title,
      clinic_id:Number(field.clinica_id),clinic_name:clinicNames.get(Number(field.clinica_id))||null,
      record_date:category==='profile'?null:dateOnly(record.Fecha),source_date:dateOnly(r.source_export_date),
      imported_date:dateOnly(field.last_imported_at instanceof Date?field.last_imported_at.toISOString():field.last_imported_at),
      author:plainText(r.author?.name)||null,sections:items.length?[{label:category==='profile'?'Datos históricos pendientes de revisión':'Contenido original',items}]:[],
      anatomy,source_document:{database:r.source_database,table:r.source_table,record_id:r.source_pk&&typeof r.source_pk==='object'?(Object.keys(r.source_pk).length===1?String(Object.values(r.source_pk)[0]):JSON.stringify(r.source_pk)):String(r.source_pk??r.source_ordinal),
        row_sha256:r.row_sha256,batch_sha256:r.batch_sha256},
      content_note:category==='prior_state'?'Tratamiento previo presente: no consta como realizado por esta clínica.'
        :category==='pending_work'?'Trabajo pendiente en la exportación. No es un plan activo ni una cita actual.'
        :category==='budget'?'Documento histórico. La aceptación y el saldo actual no se deducen de esta importación.'
        :category==='economic'?'Movimiento económico histórico. No genera una deuda ni un cobro nuevo.'
        :category==='deleted_history'?'Registro conservado como eliminado en origen; no acredita un tratamiento realizado.'
        :category==='profile'?'Datos de origen conservados para consulta. No sustituyen el resumen clínico vigente.'
        :'Registro histórico de origen; las radiografías del otro ordenador no están incluidas en esta exportación.'});
  }
  entries.sort((a,b)=>(b.record_date||'').localeCompare(a.record_date||'')||a.id.localeCompare(b.id));
  return {version:'patient_imported_history_view/1',read_only:true,entries,providers:[...new Set(entries.map(e=>e.provider))]};
}
const fold=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function paginateExternalHistory(history,query={}) {
  const limit=query.limit==null?40:Number(query.limit);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(Error('imported_history_limit_invalid'),{status:400});
  const filters={category:query.category||'',tooth:query.tooth||'',from:query.from||'',to:query.to||'',search:String(query.search||'').slice(0,200)};
  if(filters.from&&!dateOnly(filters.from)||filters.to&&!dateOnly(filters.to)||filters.tooth&&!/^\d{2}$/.test(filters.tooth))throw Object.assign(Error('imported_history_filter_invalid'),{status:400});
  const filterHash=createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0,16);let offset=0;
  if(query.cursor) {try {const cursor=JSON.parse(Buffer.from(String(query.cursor),'base64url').toString());if(cursor.filter!==filterHash||!Number.isInteger(cursor.offset)||cursor.offset<0||cursor.offset>1000000)throw Error();offset=cursor.offset;}catch{throw Object.assign(Error('imported_history_cursor_invalid'),{status:400});}}
  const entries=history.entries.filter(e=>(!filters.category||e.category===filters.category)&&(!filters.from||e.record_date&&e.record_date>=filters.from)&&(!filters.to||e.record_date&&e.record_date<=filters.to)
    &&(!filters.tooth||(e.anatomy?.teeth||[]).map(String).includes(filters.tooth)||e.sections.some(s=>s.items.some(i=>i.label==='Pieza / alcance en origen'&&i.value===filters.tooth)))
    &&(!filters.search||fold([e.title,e.author,...e.sections.flatMap(s=>s.items.map(i=>i.value))].join(' ')).includes(fold(filters.search))));
  return {...history,entries:entries.slice(offset,offset+limit),total:entries.length,next_cursor:offset+limit<entries.length?Buffer.from(JSON.stringify({offset:offset+limit,filter:filterHash})).toString('base64url'):null};
}
module.exports={eurodentEnvelopes,buildExternalPatientHistory,paginateExternalHistory,categoryFor};

// Clinical access is not financial access. Do this before filtering and totals.
function redactImportedHistoryFinancials(history,{mayViewFinancial=false}={}) {
  if(mayViewFinancial)return {...history,financial_values_visible:true};
  const financialLabels=new Set(['Documento en origen','Importe original (€)','Presupuesto de origen','Observaciones de factura']);
  const entries=history.entries.filter(entry=>entry.category!=='economic').map(entry=>({...entry,
    sections:entry.sections.map(section=>({...section,items:section.items.filter(item=>!financialLabels.has(item.label))})).filter(section=>section.items.length)}));
  return {...history,entries,providers:[...new Set(entries.map(e=>e.provider))],financial_values_visible:false};
}
function buildImportedClinicalCatalog(rows) {
  const catalog=rows[0];
  if(!catalog)return{version:'imported_clinical_catalog/1',read_only:true,provider:'eurodent',source:'Eurodent',items:[],families:[],source_instance:null,source_zip_sha256:null,imported_date:null};
  const context=parse(catalog.context_json)||{},families=(context.FamTrat||[]).map(r=>r.record).map(record=>({id:String(record.ID),name:plainText(record.Familia)}));
  const familyNames=new Map(families.map(family=>[family.id,family.name]));
  const items=(context.Tratamiento||[]).map(row=>{
    const record=row.record||{};let mapped={};
    try{mapped=require('./eurodent-odontogram').normalizeEurodentCatalogItem(record);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
    return {source_id:String(record.ID),code:plainText(record['Código']),name:plainText(record.Nombre),family_id:String(record.Familia||''),family_name:familyNames.get(String(record.Familia))||null,
      graphic:plainText(record.Grafico),visual_type:mapped.visual_type||'unclassified',hidden:mapped.hidden===true,no_tooth:record.SinPza==='1',all_teeth:record.Todos==='1'};
  });
  return{version:'imported_clinical_catalog/1',read_only:true,provider:'eurodent',source:'Eurodent',source_instance:catalog.source_instance,
    source_zip_sha256:catalog.source_zip_sha256,catalog_sha256:catalog.catalog_sha256,imported_date:dateOnly(catalog.imported_at instanceof Date?catalog.imported_at.toISOString():catalog.imported_at),items,families};
}
module.exports.redactImportedHistoryFinancials=redactImportedHistoryFinancials;
module.exports.buildImportedClinicalCatalog=buildImportedClinicalCatalog;
