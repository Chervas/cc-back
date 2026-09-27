'use strict';
const assert=require('node:assert/strict');
const {hash}=require('./adapter');
const {normalizeValues,payloadHash}=require('../treatmentPrograms.contract');
const {SOURCES,definitions,verifyVariant,sourceTreatment}=require('./obesity-program-variants');
const VERSION='cliniccloud-obesity-program-drafts/1';
const SPECS=[
 {code:'OBE-22',name:'Programa GLP-1',count:3,price:250,pages:[24],services:['glp'],
  detail:'Tres seguimientos médicos de 30 min, con receta cuando proceda. No incluye tres plumas ni automatiza prescripción o dispensación. Separación entre consultas no especificada. Médico a elección; borrador vinculado a Camacho/C7 según Excel, pendiente de ampliar alternativas sin incluir a Garrido.'},
 {code:'OBE-23',name:'Programa de nutrición',count:3,price:170,pages:[24],services:['nutrition'],
  detail:'Tres sesiones de nutrición OBE-02, de 45 min. No son primeras consultas. Pauta individual pendiente; profesional y sala se heredan del tratamiento individual.'},
 {code:'OBE-24',name:'Programa psico-nutricional',count:5,price:275,pages:[24],services:['psychonutrition'],
  detail:'Cinco sesiones psiconutricionales OBE-04 de 45 min; no usar la sesión genérica de psicología de 60 min. Pauta individual pendiente.'},
 {code:'OBE-27',name:'BS Ligereza · pérdida de peso',count:6,price:430,pages:[29,30],services:['ligereza'],weekly:true,
  detail:'Seis citas semanales de 45 min. Perfil propio: C12 durante 23 min (valoración e INDIBA), seguido de C9 durante 22 min (colocación, Lymphastim y registro). No usar los tiempos del programa postoperatorio Recuperación.'},
 {code:'OBE-28',name:'BS Transición · pérdida de peso',count:8,price:670,pages:[31,32],services:['ligereza','firmness'],weekly:true,
  detail:'Ocho citas semanales de 45 min. Impares 1/3/5/7: sesión Ligereza. Pares 2/4/6/8: EXION Body + INDIBA, 20 + 25 min en C12. La variante clínica se consulta en el protocolo de obesidad; no modifica el tratamiento corporal individual.'},
 {code:'OBE-29',name:'BS Firmeza · pérdida de peso',count:12,price:1090,pages:[33,34],series:[['firmness',8],['emshape',4]],
  detail:'Programa de 12 citas, distinto del BS Firmeza corporal de ocho. Ocho citas EXION + INDIBA de 45 min, una por semana; cuatro EMShape de 30 min, dos por semana en días no consecutivos. Nunca reunir ambas series en la misma cita. La lista agrupa las dos series para mostrar su composición: NO representa su orden cronológico. Falta decidir inicio e intercalación del calendario individual. No programar primero las ocho y después las cuatro por defecto.'},
 {code:'OBE-30',name:'BS Reconstrucción · pérdida de peso',count:16,price:1290,pages:[35,36],series:[['firmness',10],['emshape',6]],
  detail:'Diez citas EXION + INDIBA de 45 min, una por semana; seis EMShape de 30 min, dos por semana en días no consecutivos. Nunca ambos tipos en la misma cita. La lista agrupa series, NO ordena su ejecución: calendario individual e intercalación pendientes. El documento exige valoración previa de cirugía plástica; recepción no debe venderlo como una alternativa automática a la cirugía.'},
];
function prepare({plan,sourceHashes,clinics,treatments,existingPrograms}){
 assert(clinics.some(c=>c.id_clinica===72&&c.grupoClinicaId===29));
 const variants=definitions({plan,sourceHashes,treatments}),bindings={};
 for(const v of variants){
  const rows=treatments.filter(t=>t.codigo===v.payload.codigo);assert.equal(rows.length,1,'Create reviewed variants first');
  verifyVariant(rows[0],v);bindings[v.key]={id:rows[0].id_tratamiento,before_sha256:hash(rows[0]),label:rows[0].nombre,minutes:rows[0].duracion_min};
 }
 for(const [key,sheet,row,minutes,options]of [
  ['nutrition','Obesidad · tarifa',5,45],['psychonutrition','Obesidad · tarifa',7,45],
  ['firmness','Tratamientos individuales',22,45],['emshape','Tratamientos individuales',31,30,{allowMissingKey:true}],
 ]){
  const t=sourceTreatment(plan,treatments,sheet,row,minutes,options);
  bindings[key]={id:t.id_tratamiento,before_sha256:hash(t),label:t.nombre,minutes};
 }
 const labels={glp:'Seguimiento médico GLP-1',nutrition:'Nutrición',psychonutrition:'Psiconutrición',ligereza:'INDIBA + Lymphastim · Ligereza',firmness:'EXION Body + INDIBA',emshape:'EMShape'};
 const programs=SPECS.map(s=>{
  const order=s.series?s.series.flatMap(([key,count])=>Array.from({length:count},(_,i)=>({key,serial:i+1,count}))):
   Array.from({length:s.count},(_,i)=>({key:s.services[i%s.services.length],serial:i+1,count:s.count}));
  assert.equal(order.length,s.count);
  const appointments=order.map((entry,i)=>({key:s.code.toLowerCase().replace(/-/g,'_')+'_'+(i+1),
   label:(s.series?'Serie · ':'')+`${labels[entry.key]} · ${entry.serial}/${entry.count}`,
   treatment_ids:[bindings[entry.key].id],offset_days:s.weekly?i*7:null}));
  const notes=[
   'BORRADOR DOCUMENTAL · No habilitado para vender ni reservar.',
   `${s.code} · Protocolo Obesidad V4, páginas PDF ${s.pages.join(', ')} (numeración impresa dos páginas menor). Tarifa 2026 Obesidad.`,
   `${s.count} citas. Precio documental final: ${s.price} €. Vigencia desde 01/10/2026; no aplicado al precio comercial. Confirmar fiscalidad y aprobación antes de activar.`,
   s.detail,
   s.weekly?'Separación documentada semanal: días 0, 7, 14… desde el inicio; confirmar el calendario concreto.':'Sin días fijos preasignados: no se inventa una pauta ni se convierte un rango en frecuencia única.',
   'Caducidad indicada por el documento: 12 meses desde la compra. Se conserva como condición documental, NO como regla de caducidad ya implementada.',
   s.code>='OBE-27'?'Los programas corporales de pérdida de peso requieren estudio previo e indicación médica. No se selecciona un programa automáticamente por kilos perdidos. Las mediciones inicial/final del circuito no crean citas adicionales por cada programa. Firmeza y Reconstrucción requieren la revisión clínica de estabilidad del peso y demás condiciones del documento.':'Conservar seguimiento clínico y consentimiento aplicable; la composición comercial no acredita que se haya realizado ninguna consulta.',
   'Pendientes: revisión clínica, profesionales cuando proceda, consentimientos, precio vigente y fiscalidad. No aprueba protocolos, no receta ni dispensa medicación, no firma consentimientos ni crea ventas, citas o recordatorios.',
   `Procedencia PDF SHA-256: ${Object.entries(SOURCES).map(([name,sha])=>`${name}: ${sha}`).join('; ')}.`,
  ].join('\n\n');
  const values=normalizeValues({name:s.name,kind:'program',status:'draft',total_price:null,cadence:null,appointments,notes});
  const idempotency_key=VERSION+':'+s.code;
  assert(!existingPrograms.some(p=>p.name.normalize('NFKC').toLowerCase()===s.name.toLowerCase()&&p.request_key!==payloadHash([72,idempotency_key])),'OBESITY_PROGRAM_NAME_COLLISION');
  return{code:s.code,clinic_id:72,payload:{...values,idempotency_key},source_pages:s.pages,source_gross_price:s.price,source_effective_date:'2026-10-01'};
 });
 const body={version:VERSION,source_hashes:SOURCES,source_plan_sha256:plan.plan_sha256,bindings,programs,
  policy:{draft_only:true,treatments_changed:false,existing_programs_changed:false,clinical_approval:false,appointments_created:false,
   sales_created:false,prescriptions_created:false,reminders_activated:false,future_prices_applied:false}};
 return{...body,package_sha256:hash(body)};
}
module.exports={VERSION,SOURCES,SPECS,prepare};
