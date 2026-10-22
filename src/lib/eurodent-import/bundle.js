'use strict';
const { createHash } = require('node:crypto');
const { dateOnly, plainText } = require('../cliniccloud-patient-history');
const stable = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const sourceKey = (instance, id) => `eurodent_identity_${digest([instance, String(id)]).slice(0,40)}`;
const rowKey = (instance, row) => digest([instance,row.source_database,row.source_table,row.source_pk ?? row.source_ordinal]);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const TABLES = new Set(['Paciente','Historial','Primera_Visita','Trabajo_Pendiente','Presupuestos','Presupuesto','Comentarios','Piezas','Piezas_pri','Factura','Factura2','Recibo','Recibo2','Hist_Borr']);
function validateBundle(bundle) {
  if (bundle?.version !== 'eurodent_patient_bundle/1' || bundle.source_system !== 'eurodent'
    || !/^[a-z0-9][a-z0-9._-]{2,99}$/.test(bundle.source_instance || '')
    || !/^[a-f0-9]{64}$/.test(bundle.sha256 || '')
    || digest(Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== 'sha256'))) !== bundle.sha256
    || !['source_inventory_sha256','intake_sha256','source_zip_sha256'].every(key=>/^[a-f0-9]{64}$/.test(bundle[key]||''))
    || !bundle.operational_effects || Object.values(bundle.operational_effects).some(value=>value!==false)
    || !Array.isArray(bundle.patients) || bundle.patients.length < 1 || bundle.patients.length > 50) throw Error('EURODENT_BUNDLE_INVALID');
  const identities = new Set(), rows = new Set();
  for (const patient of bundle.patients) {
    if (!/^[1-9]\d*$/.test(patient.source_patient_id) || identities.has(patient.source_patient_id)
      || !Array.isArray(patient.records) || patient.records.length > 20000) throw Error('EURODENT_SELECTION_INVALID');
    identities.add(patient.source_patient_id);
    if (patient.records.filter(row => row.source_table === 'Paciente').length !== 1) throw Error('EURODENT_PROFILE_REQUIRED');
    for (const row of patient.records) {
      if (row.source_database !== 'datos/EDD00001.MDB' || !TABLES.has(row.source_table)
        || !/^[a-f0-9]{64}$/.test(row.row_sha256 || '') || !/^[a-f0-9]{64}$/.test(row.database_sha256 || '')
        || !row.record || Array.isArray(row.record) || typeof row.record !== 'object' || digest(row.record)!==row.row_sha256) throw Error('EURODENT_ROW_INVALID');
      if(!row.source_pk || String(row.source_pk.ID)!==String(row.record.ID))throw Error('EURODENT_SOURCE_PRIMARY_KEY_INVALID');
      if(['Factura2','Recibo2'].includes(row.source_table)){
        const parentTable=row.source_table==='Factura2'?'Factura':'Recibo';
        if(!patient.records.some(parent=>parent.source_table===parentTable&&String(parent.record.ID)===String(row.record.IDF)))throw Error('EURODENT_SOURCE_PARENT_MISSING');
      }
      const sourceOwner = String(row.source_table === 'Paciente' ? row.record.ID : row.record.IDP ?? patient.source_patient_id);
      if (sourceOwner !== patient.source_patient_id) throw Error('EURODENT_FOREIGN_SOURCE_ROW');
      const key = rowKey(bundle.source_instance,row);
      if (rows.has(key)) throw Error('EURODENT_SOURCE_KEY_DUPLICATED');
      rows.add(key);
      if (Buffer.byteLength(JSON.stringify(envelope(bundle,row,patient.source_patient_id))) > 1048576) throw Error('EURODENT_ARCHIVE_ROW_TOO_LARGE');
    }
  }
  return bundle;
}
function envelope(bundle,row,sourcePatientId) {
  return {version:'eurodent_source_record/1',source_instance:bundle.source_instance,source_patient_id:sourcePatientId,
    batch_sha256:bundle.sha256,intake_sha256:bundle.intake_sha256,source_zip_sha256:bundle.source_zip_sha256||null,source_export_date:bundle.source_export_date||null,...row};
}
function profileFor(patient) {
  const record=patient.records.find(row=>row.source_table==='Paciente').record;
  const nombre=plainText(record.Nombre);
  if (!nombre || nombre.length>255) throw Error('EURODENT_NAME_REQUIRED');
  return {nombre,apellidos:'',dni:plainText(record.Nif)||null,email:plainText(record['E-mail'])||null,
    telefono_movil:plainText(record.Movil)||null,telefono_secundario:plainText(record['Teléfono'])||null,
    fecha_nacimiento:dateOnly(record.FechNac),direccion:plainText(record['Dirección'])||null,codigo_postal:plainText(record['CódPostal'])||null,
    poblacion:plainText(record['Población'])||null,provincia:plainText(record.Provincia)||null,profesion:plainText(record['Profesión'])||null,source_history_number:plainText(record['NºHist'])||null};
}
module.exports={stable,digest,parse,sourceKey,rowKey,validateBundle,envelope,profileFor,TABLES};
