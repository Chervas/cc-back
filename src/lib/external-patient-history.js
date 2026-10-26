'use strict';
const { createHash } = require('node:crypto');
const { buildClinicCloudPatientHistory,dateOnly,plainText } = require('./cliniccloud-patient-history');
const parse = value => {try {return typeof value === 'string' ? JSON.parse(value) : value;} catch {return null;}};
const hasEconomicEvidence = row => ['COBR','0213'].includes(String(row.catalog?.code || '').trim().toUpperCase())
  || ['C','A'].includes(String(row.record?.Tipolin || '').trim().toUpperCase());
const categoryFor = row => row.source_table === 'Paciente' ? 'profile' : row.source_table === 'Primera_Visita' ? 'prior_state'
  : row.source_table === 'Trabajo_Pendiente' ? 'pending_work' : ['Presupuestos','Presupuesto'].includes(row.source_table) ? 'budget'
  : row.source_table === 'Comentarios' ? 'comment' : ['Factura','Factura2','Recibo','Recibo2'].includes(row.source_table) ? 'economic'
  : ['Historial','Hist_Borr'].includes(row.source_table) && hasEconomicEvidence(row) ? 'economic'
  : row.source_table === 'Hist_Borr' ? 'deleted_history'
  : 'historical';
function eurodentEnvelopes(fields) {
  return (Array.isArray(fields)?fields:[]).filter(field=>field?.source==='eurodent' && Number(field.clinica_id)>0)
    .map(field=>({field,envelope:parse(field.value)})).filter(({envelope:r})=>r?.version==='eurodent_source_record/1'
      && r.source_instance && r.source_table && r.record && !Array.isArray(r.record));
}
function arriagaEnvelopes(fields) {
  return (Array.isArray(fields)?fields:[]).filter(field=>field?.source==='arriaga_excel')
    .map(field=>({field,envelope:parse(field.value)})).filter(({field,envelope:r})=>{
      const clinicId=Number(field.clinica_id);
      return Number.isSafeInteger(clinicId)&&clinicId>0
        &&r?.version==='arriaga_patient_source_record/1'&&r.provider==='arriaga_excel'
        &&Number(r.clinic_id)===clinicId&&r.category==='historical'
        &&typeof r.source_instance==='string'&&r.source_instance.endsWith(`:clinic-${clinicId}`)
        &&typeof r.source_patient_id==='string'&&/^master-row-[1-9]\d*$/.test(r.source_patient_id)
        &&typeof r.source_database==='string'&&plainText(r.source_database)
        &&typeof r.source_table==='string'&&plainText(r.source_table)
        &&Number.isSafeInteger(r.source_row)&&r.source_row>1
        &&/^[a-f0-9]{64}$/.test(r.source_key||'')
        &&/^\d{4}-\d{2}-\d{2}$/.test(r.record_date||'')&&dateOnly(r.record_date)===r.record_date
        &&r.record&&typeof r.record==='object'&&!Array.isArray(r.record)
        &&plainText(r.record.service_label||r.record.service_name)
        &&(!field.archive_source_instance||field.archive_source_instance===r.source_instance)
        &&(!field.archive_source_patient_id||field.archive_source_patient_id===r.source_patient_id)
        &&(!field.archive_source_key||field.archive_source_key===r.source_key);
    });
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
      ...(r.source_table==='Hist_Borr'?{source_deleted:true}:{}),
      clinic_id:Number(field.clinica_id),clinic_name:clinicNames.get(Number(field.clinica_id))||null,
      record_date:category==='profile'?null:dateOnly(record.Fecha),source_date:dateOnly(r.source_export_date),
      imported_date:dateOnly(field.last_imported_at instanceof Date?field.last_imported_at.toISOString():field.last_imported_at),
      author:plainText(r.author?.name)||null,sections:items.length?[{label:category==='profile'?'Datos históricos pendientes de revisión':'Contenido original',items}]:[],
      anatomy,source_document:{database:r.source_database,table:r.source_table,record_id:r.source_pk&&typeof r.source_pk==='object'?(Object.keys(r.source_pk).length===1?String(Object.values(r.source_pk)[0]):JSON.stringify(r.source_pk)):String(r.source_pk??r.source_ordinal),
        row_sha256:r.row_sha256,batch_sha256:r.batch_sha256},
      content_note:category==='prior_state'?'Tratamiento previo presente: no consta como realizado por esta clínica.'
        :category==='pending_work'?'Trabajo pendiente en la exportación. No es un plan activo ni una cita actual.'
        :category==='budget'?'Documento histórico. La aceptación y el saldo actual no se deducen de esta importación.'
        :category==='economic'?`Movimiento económico histórico. No genera una deuda ni un cobro nuevo.${r.source_table==='Hist_Borr'?' Registro conservado como eliminado en origen; no acredita un tratamiento realizado.':''}`
        :category==='deleted_history'?'Registro conservado como eliminado en origen; no acredita un tratamiento realizado.'
        :category==='profile'?'Datos de origen conservados para consulta. No sustituyen el resumen clínico vigente.'
        :'Registro histórico de origen; las radiografías del otro ordenador no están incluidas en esta exportación.'});
  }
  for(const {field,envelope:r} of arriagaEnvelopes(fields)){
    const record=r.record,items=[];
    const add=(label,value)=>{value=plainText(value);if(value)items.push({label,value});};
    add('Servicio registrado',record.service_label||record.service_name);
    add('Familia',record.service_family);add('Clasificación de origen',record.source_classification);
    const site={explicit_aju:'Ajuriaguerra · indicada como AJU en origen',explicit_arenal:'Arenal · indicada en origen',default_arenal:'Arenal · asignada cuando el archivo no indica sede'}[record.site_assignment];
    add('Sede del registro',site);
    const id=createHash('sha256').update(`${field.clinica_id}:${r.source_instance}:${r.source_key}`).digest('hex').slice(0,24);
    entries.push({id,provider:'arriaga_excel',source:'Excel Arriaga',kind:'clinical_note',category:'historical',
      title:plainText(record.service_label||record.service_name),clinic_id:Number(field.clinica_id),
      clinic_name:clinicNames.get(Number(field.clinica_id))||null,record_date:r.record_date,
      source_date:dateOnly(r.source_export_date),
      imported_date:dateOnly(field.last_imported_at instanceof Date?field.last_imported_at.toISOString():field.last_imported_at),
      author:null,sections:[{label:'Servicio histórico registrado',items}],
      source_document:{database:plainText(r.source_database),table:plainText(r.source_table),record_id:String(r.source_row),
        row_sha256:r.row_sha256,batch_sha256:r.bundle_sha256},
      content_note:'Actividad clínica recogida en el listado de origen.'});
  }
  entries.sort((a,b)=>(b.record_date||'').localeCompare(a.record_date||'')||a.id.localeCompare(b.id));
  return {version:'patient_imported_history_view/1',read_only:true,entries,providers:[...new Set(entries.map(e=>e.provider))]};
}
const fold=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const financialLabels=new Set(['Documento en origen','Importe original (€)','Presupuesto de origen','Observaciones de factura']);
const scopeCategories={clinical:new Set(['historical','prior_state','pending_work','comment','deleted_history']),
  economy:new Set(['budget','economic']),profile:new Set(['profile'])};
function validateImportedHistoryScope(scope) {
  if(scope===undefined)return '';
  if(typeof scope!=='string'||!Object.hasOwn(scopeCategories,scope))throw Object.assign(Error('imported_history_scope_invalid'),{status:400});
  return scope;
}
function paginateExternalHistory(history,query={}) {
  const scope=validateImportedHistoryScope(query.scope);
  // A clinical diary does not expose financial fields even to a billing
  // administrator. Strip them before search so amounts cannot match a query.
  if(scope==='clinical')history=redactImportedHistoryFinancials(history);
  const limit=query.limit==null?40:Number(query.limit);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(Error('imported_history_limit_invalid'),{status:400});
  const filters={...(scope?{scope}:{}),category:query.category||'',tooth:query.tooth||'',from:query.from||'',to:query.to||'',search:String(query.search||'').slice(0,200)};
  if(filters.from&&!dateOnly(filters.from)||filters.to&&!dateOnly(filters.to)||filters.tooth&&!/^\d{2}$/.test(filters.tooth))throw Object.assign(Error('imported_history_filter_invalid'),{status:400});
  const filterHash=createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0,16);let offset=0;
  if(query.cursor) {try {const cursor=JSON.parse(Buffer.from(String(query.cursor),'base64url').toString());if(cursor.filter!==filterHash||!Number.isInteger(cursor.offset)||cursor.offset<0||cursor.offset>1000000)throw Error();offset=cursor.offset;}catch{throw Object.assign(Error('imported_history_cursor_invalid'),{status:400});}}
  // Navigation covers the complete authorized domain, not just this page or
  // query. The caller has already removed financial entries the role cannot see.
  const domainEntries=scope==='economy'?history.entries.filter(entry=>scopeCategories.economy.has(entry.category)
    || entry.sections.some(section=>section.items.some(item=>financialLabels.has(item.label))))
      .map(entry=>scopeCategories.economy.has(entry.category)?entry:{...entry,source_category:entry.category,category:'economic'})
    :scope?history.entries.filter(entry=>scopeCategories[scope].has(entry.category)):history.entries;
  const categoryCounts={};
  for(const entry of domainEntries)categoryCounts[entry.category]=(categoryCounts[entry.category]||0)+1;
  const entries=domainEntries.filter(e=>(!filters.category||e.category===filters.category)&&(!filters.from||e.record_date&&e.record_date>=filters.from)&&(!filters.to||e.record_date&&e.record_date<=filters.to)
    &&(!filters.tooth||(e.anatomy?.teeth||[]).map(String).includes(filters.tooth)||e.sections.some(s=>s.items.some(i=>i.label==='Pieza / alcance en origen'&&i.value===filters.tooth)))
    &&(!filters.search||fold([e.title,e.author,...e.sections.flatMap(s=>s.items.map(i=>i.value))].join(' ')).includes(fold(filters.search))));
  return {...history,...(scope?{providers:[...new Set(domainEntries.map(entry=>entry.provider))]}:{}),category_counts:categoryCounts,entries:entries.slice(offset,offset+limit),total:entries.length,next_cursor:offset+limit<entries.length?Buffer.from(JSON.stringify({offset:offset+limit,filter:filterHash})).toString('base64url'):null};
}
module.exports={eurodentEnvelopes,arriagaEnvelopes,buildExternalPatientHistory,paginateExternalHistory,categoryFor,validateImportedHistoryScope};

// Clinical access is not financial access. Do this before filtering and totals.
function redactImportedHistoryFinancials(history,{mayViewFinancial=false}={}) {
  if(mayViewFinancial)return {...history,financial_values_visible:true};
  const entries=history.entries.filter(entry=>entry.category!=='economic').map(entry=>({...entry,
    sections:entry.sections.map(section=>({...section,items:section.items.filter(item=>!financialLabels.has(item.label))})).filter(section=>section.items.length)}));
  return {...history,entries,providers:[...new Set(entries.map(e=>e.provider))],financial_values_visible:false};
}
function buildImportedClinicalCatalog(rows) {
  // Only Eurodent catalogues contain the original dental graphics contract.
  // Other providers' retained contexts must not become Eurodent catalogues.
  const catalog=rows.find(row=>row.source_system==='eurodent');
  if(!catalog)return{version:'imported_clinical_catalog/1',read_only:true,provider:'eurodent',source:'Eurodent',items:[],families:[],source_instance:null,source_zip_sha256:null,imported_date:null};
  // Tratamiento.Familia references the graphic family number, not FamTrat's
  // row PK (the archived family is NumFamilia=99 with ID=26 in the source).
  const context=parse(catalog.context_json)||{},families=(context.FamTrat||[]).map(r=>r.record).map(record=>({
    id:String(Object.hasOwn(record,'NumFamilia')?(record.NumFamilia??''):(record.ID??'')).trim(),
    source_id:String(record.ID??''),name:plainText(record.Familia),
  }));
  const familyNames=new Map(families.filter(family=>family.id!=='').map(family=>[family.id,family.name]));
  const items=(context.Tratamiento||[]).map(row=>{
    const record=row.record||{};let mapped={};
    try{mapped=require('./eurodent-odontogram').normalizeEurodentCatalogItem(record);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
    return {source_id:String(record.ID),code:plainText(record['Código']),name:plainText(record.Nombre),family_id:String(record.Familia??'').trim(),family_name:familyNames.get(String(record.Familia??'').trim())||null,
      graphic:mapped.graphic===true,visual_type:mapped.visual_type||null,hidden:mapped.hidden===true,no_tooth:record.SinPza==='1',all_teeth:record.Todos==='1'};
  });
  return{version:'imported_clinical_catalog/1',read_only:true,provider:'eurodent',source:'Eurodent',source_instance:catalog.source_instance,
    source_zip_sha256:catalog.source_zip_sha256,catalog_sha256:catalog.catalog_sha256,imported_date:dateOnly(catalog.imported_at instanceof Date?catalog.imported_at.toISOString():catalog.imported_at),items,families};
}
module.exports.redactImportedHistoryFinancials=redactImportedHistoryFinancials;
module.exports.buildImportedClinicalCatalog=buildImportedClinicalCatalog;
