'use strict';
// Entirely fictitious values; no import package, production data or credentials.
const {hash}=require('../../../lib/cliniccloud-import/adapter');
const {SOURCES}=require('../../../lib/cliniccloud-import/obesity-program-variants');
function fixture(){
 const rows=[],treatments=[];
 for(const [i,[sheet,row,minutes,doctor,room]]of [
  ['Obesidad · tarifa',16,5,53,80],['Tratamientos individuales',9,45,221,87],
  ['Obesidad · tarifa',5,45,223,77],['Obesidad · tarifa',7,45,126,74],
  ['Tratamientos individuales',22,45,221,87],['Tratamientos individuales',31,30,221,85],
 ].entries()){
  const source={sheet,source_row:row,kind:'treatment',clinic_id:72,proposed_code:'SYNTHETIC-OBE-'+i,
   display_name:'Prueba ficticia '+i,source_catalog_key:'key-'+i,provenance:{file_sha256:hash('fiction'),source_row:row,sheet,row_sha256:hash('row-'+i)}};
  rows.push(source);
  const phase={key:'phase_1',label:'Ficticio',duration_minutes:minutes,installation_ids:[room],professionals:{mode:'any',ids:[doctor],preferred_id:doctor}};
  const phases=i===1?[{...phase,duration_minutes:28,equipment_requirements:[{equipment_ids:[14]}]},
   {...phase,key:'phase_2',duration_minutes:17,installation_ids:[82],equipment_requirements:[{equipment_ids:[11]}]}]:[phase];
  treatments.push({id_tratamiento:i+1,nombre:source.display_name,codigo:source.proposed_code,clinica_id:72,origen:'clinica',activo:0,
   disciplina:i===0?'general':'estetica',duracion_min:minutes,sesiones_defecto:1,clinical_config:{catalog_status:'draft',
    ...(i===5?{}:{source_catalog_key:source.source_catalog_key}),source_catalog:source.provenance,booking_profile:{version:2,phases}}});
 }
 const body={version:1,mode:'catalog_dry_run_only',workbook_sha256:hash('fiction'),clinics:{medical:72,capilar:66},rows};
 const staff=[{id:23,doctor_id:53,clinica_id:72,activo:1,recibe_citas:1},{id:119,doctor_id:221,clinica_id:72,activo:1,recibe_citas:1}];
 return{plan:{...body,plan_sha256:hash(body)},sourceHashes:{...SOURCES},before:{
  clinics:[{id_clinica:72,grupoClinicaId:29,equipment_booking_enabled:1}],treatments,existingVariants:[],
  programs:[{id:1,name:'Programa ajeno ficticio',clinic_id:66}],staff,
  staff_hours:staff.map(s=>({id:s.id,doctor_clinica_id:s.id,activo:1,hora_inicio:'09:00',hora_fin:'20:00'})),
  rooms:[80,82,87].map(id=>({id,clinica_id:72,activo:1,capacidad:1,tiempo_preparacion_minutos:0,profesionales_permitidos:[id===80?53:221]})),
  room_hours:[80,82,87].map(id=>({id,instalacion_id:id,activo:1,hora_inicio:'09:00',hora_fin:'20:00'})),
  units:[[14,87,'indiba_rf'],[11,82,'btl_lymphastim']].map(([id,home_installation_id,family_key])=>({id,home_installation_id,family_key,
   group_id:29,owner_clinic_id:72,status:'available',turnaround_minutes:0,mobility:'fixed'})),
  shares:[14,11].map(equipment_id=>({equipment_id,clinic_id:72})),aliases:[],policies:[{installation_id:82,mode:'none',equipment_ids:[]}],
 }};
}
module.exports={fixture};
