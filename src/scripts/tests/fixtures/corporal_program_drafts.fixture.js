'use strict';
const {hash}=require('../../../lib/cliniccloud-import/adapter');
const {SOURCES,BINDINGS}=require('../../../lib/cliniccloud-import/corporal-program-drafts');
function fixture(){
 const rows=[],treatments=[];
 for(const [index,[sourceRow,minutes]]of Object.values(BINDINGS).entries()){
  const source={sheet:'Tratamientos individuales',source_row:sourceRow,kind:'treatment',clinic_id:72,
   proposed_code:'SYNTHETIC-'+sourceRow,display_name:'Prueba ficticia '+sourceRow,source_catalog_key:'key-'+sourceRow,
   provenance:{file_sha256:hash('fiction'),source_row:sourceRow}};rows.push(source);
  treatments.push({id_tratamiento:index+1,codigo:source.proposed_code,nombre:source.display_name,clinica_id:72,origen:'clinica',
   activo:0,duracion_min:minutes,sesiones_defecto:1,clinical_config:{catalog_status:'draft',source_catalog_key:source.source_catalog_key,source_catalog:source.provenance}});
 }
 const body={version:1,mode:'catalog_dry_run_only',workbook_sha256:hash('fiction'),clinics:{medical:72,capilar:66},rows};
 return{plan:{...body,plan_sha256:hash(body)},sourceHashes:{...SOURCES},clinics:[{id_clinica:72,grupoClinicaId:29}],treatments,existingPrograms:[]};
}
module.exports={fixture};
