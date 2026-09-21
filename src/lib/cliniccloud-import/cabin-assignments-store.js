'use strict';
const { hash }=require('./adapter');
const { instant }=require('./appointments-apply');
const sqlDate=value=>instant(value).replace('T',' ').replace('Z','');
async function createCabinStore(c,{readOnly=true}={}) {
 const q=async(sql,args=[]) => (await c.query(sql,args))[0];
 const clinics=await q('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica');
 if(clinics.length!==2||clinics.some(r=>r.grupoClinicaId!==29))throw Error('CABIN_GROUP_CHANGED');
 const triggers=await q("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='CitasPacientes'");
 if(triggers.length)throw Error('CABIN_TRIGGERS_REQUIRE_REVIEW');
 let writing=false;
 return {
  async read(id,lock=false){
   if(lock&&(!writing||readOnly))throw Error('CABIN_WRITE_TRANSACTION_REQUIRED');
   return (await q(`SELECT * FROM CitasPacientes WHERE id_cita=? AND clinica_id IN (66,72)${lock?' FOR UPDATE':''}`,[id]))[0];
  },
  async validate(op){
   const reasons=[],id=op.cabin.id,before=op.before;
   const rooms=await q(`SELECT * FROM Instalaciones WHERE id=?${writing?' FOR UPDATE':''}`,[id]);
   if(rooms.length!==1||hash(rooms[0])!==op.cabin_sha256)return ['CABIN_ROOM_CHANGED'];
   const links=await q('SELECT installation_id,canonical_installation_id,group_id FROM InstallationPhysicalAliases WHERE installation_id=? OR canonical_installation_id=?',[id,id]);
   const canonical=Number(links.find(r=>r.installation_id===id)?.canonical_installation_id||id);
   const related=await q('SELECT installation_id,canonical_installation_id,group_id FROM InstallationPhysicalAliases WHERE installation_id=? OR canonical_installation_id=?',[canonical,canonical]);
   if([...links,...related].some(r=>r.group_id!==29)||related.some(r=>r.installation_id===canonical))return ['CABIN_ALIAS_SCOPE_CHANGED'];
   const ids=[...new Set([id,canonical,...related.map(r=>r.installation_id)])];
   if(writing){
    for(const key of [`installation:${canonical}`,`patient:${before.paciente_id}`].sort()){
     await q('INSERT INTO AppointmentBookingResources (resource_key,resource_kind,created_at,updated_at) VALUES (?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE resource_key=VALUES(resource_key)',[key,key.split(':')[0]]);
     await q('SELECT resource_key FROM AppointmentBookingResources WHERE resource_key=? FOR UPDATE',[key]);
    }
   }
   const patients=await q("SELECT DISTINCT paciente_id FROM PatientCustomFields WHERE clinica_id IN (66,72) AND source='cliniccloud' AND (((source_column='idContacto' OR field_key='cliniccloud_source_contact_id') AND TRIM(value)=?) OR (source_column IN ('contacto_1.csv','cliniccloud_contact_snapshot') AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(value) THEN value ELSE '{}' END,'$.contact.idContacto'))=?))",[op.source.source_contact_id,op.source.source_contact_id]);
   if(patients.length!==1||patients[0].paciente_id!==before.paciente_id)reasons.push('CABIN_PATIENT_LINK_CHANGED');
   const clashes=await q("SELECT id_cita FROM CitasPacientes WHERE id_cita<>? AND estado <> 'cancelada' AND inicio<? AND fin>? AND (instalacion_id IN (?) OR paciente_id=?) LIMIT 1",[op.appointment_id,sqlDate(before.fin),sqlDate(before.inicio),ids,before.paciente_id]);
   if(clashes.length)reasons.push('CABIN_CURRENT_APPOINTMENT_OVERLAP');
   const keys=ids.map(i=>`installation:${i}`);
   const occupied=await q("SELECT o.id FROM AppointmentBookingOccupancies o JOIN CitasPacientes a ON a.id_cita=o.appointment_id WHERE o.appointment_id=? OR (o.resource_key IN (?) AND a.estado<>'cancelada' AND o.start_at<? AND o.end_at>?) LIMIT 1",[op.appointment_id,keys,sqlDate(before.fin),sqlDate(before.inicio)]);
   if(occupied.length)reasons.push('CABIN_ADVANCED_OCCUPANCY_REQUIRES_CANONICAL_COMMAND');
   return reasons;
  },
  async transaction(fn){
   if(readOnly||writing)throw Error('CABIN_WRITE_TRANSACTION_REQUIRED');
   await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();writing=true;
   try{const result=await fn(this);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{writing=false;}
  },
  async update(id,patch){
   if(readOnly||!writing||Object.keys(patch).sort().join(',')!=='import_metadata,instalacion_id,updated_at')throw Error('CABIN_WRITE_COLUMNS_INVALID');
   const result=await q("UPDATE CitasPacientes SET instalacion_id=?,import_metadata=?,updated_at=? WHERE id_cita=? AND source_system='cliniccloud' AND estado='pendiente'",[patch.instalacion_id,JSON.stringify(patch.import_metadata),sqlDate(patch.updated_at),id]);
   if(result.affectedRows!==1)throw Error('CABIN_UPDATE_FAILED');
  },
 };
}
module.exports={createCabinStore};
