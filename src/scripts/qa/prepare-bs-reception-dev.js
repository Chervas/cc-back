#!/usr/bin/env node
'use strict';
// Explicit operator command. The source transaction is READ ONLY and selects
// configuration only. No source patients, appointments, staff identities,
// signatures, credentials, provider bindings or communications are read/copied.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const KEY = 'bs-reception-dev-v1';
const j = v => typeof v === 'string' ? JSON.parse(v) : v;
const pick = (row, keys) => Object.fromEntries(keys.split(' ').filter(k => row[k] !== undefined).map(k => [k, row[k]]));
const ids = (value, map) => (j(value) || []).map(id => { assert(map.has(Number(id)), `Unmapped configuration ID ${id}`); return map.get(Number(id)); });

async function source() {
  const c = await require('../../lib/cliniccloud-import/operator-database').connectOperatorDatabase('crm');
  try {
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const select = async sql => (await c.query(sql))[0];
    const scope = 'IN (66,72)';
    const data = {
      doctors: await select(`SELECT id,doctor_id,clinica_id,rol_en_clinica,recibe_citas,activo FROM DoctorClinicas WHERE clinica_id ${scope}`),
      rooms: await select(`SELECT id,clinica_id,nombre,tipo,piso,capacidad,activo,requiere_preparacion,tiempo_preparacion_minutos,default_duracion_minutos,profesionales_permitidos,orden_visualizacion FROM Instalaciones WHERE clinica_id ${scope}`),
      aliases: await select('SELECT installation_id,canonical_installation_id FROM InstallationPhysicalAliases WHERE group_id=29'),
      equipment: await select(`SELECT id,owner_clinic_id,name,family_key,aliases,mobility,status,turnaround_minutes,home_installation_id FROM BookingEquipment WHERE owner_clinic_id ${scope}`),
      equipmentClinics: await select(`SELECT equipment_id,clinic_id FROM BookingEquipmentClinics WHERE clinic_id ${scope}`),
      policies: await select(`SELECT p.installation_id,p.mode,p.equipment_ids FROM BookingEquipmentRoomPolicies p JOIN Instalaciones i ON i.id=p.installation_id WHERE i.clinica_id ${scope}`),
      treatments: await select(`SELECT id_tratamiento,clinica_id,nombre,codigo,disciplina,especialidad,categoria,duracion_min,precio_base,sesiones_defecto,requiere_pieza,requiere_zona,activo,clinical_config,asignacion_instalacion_tipo,tipo_instalacion_requerida,instalaciones_habilitadas FROM Tratamientos WHERE clinica_id ${scope}`),
      programs: await select(`SELECT id,clinic_id,name,kind,status,total_price,appointments,cadence FROM TreatmentPrograms WHERE clinic_id ${scope}`),
      templates: await select(`SELECT id,clinic_id,catalog_key,name,description,purpose,status,blocking_policy,validity_mode,is_default,requires_patient_signature,requires_representative_when_minor,requires_professional_signature FROM ClinicConsentTemplates WHERE clinic_id ${scope}`),
      versions: await select(`SELECT v.clinic_template_id,v.version,v.locale,v.title,v.body_json,v.body_html,v.variable_schema,v.status,v.published_at FROM ClinicConsentTemplateVersions v JOIN ClinicConsentTemplates t ON t.id=v.clinic_template_id WHERE t.clinic_id ${scope}`),
      requirements: await select(`SELECT r.tratamiento_id,r.clinica_id,r.clinic_template_id,r.catalog_template_id,r.requirement_scope,r.condition_key,r.required,r.blocking_policy,r.sort_order FROM TreatmentConsentRequirements r JOIN Tratamientos t ON t.id_tratamiento=r.tratamiento_id WHERE t.clinica_id ${scope}`),
      protocols: await select(`SELECT clinic_id,title,kind,status,version,content,treatment_ids FROM TreatmentProtocols WHERE clinic_id ${scope}`),
    };
    await c.rollback(); return data;
  } finally { await c.end(); }
}

async function seed(db, s, tx) {
  const create = (name, values) => db[name].create(values, { transaction: tx, hooks: false });
  await db.Clinica.findByPk(1, { transaction: tx, lock: tx.LOCK.UPDATE });
  const existing = await db.Clinica.findOne({ where: { nombre_clinica: 'BS Medical · DEV' }, transaction: tx });
  if (existing) {
    assert.equal(j(existing.configuracion).qa_demo.key, KEY);
    return { preserved: true, clinicId: existing.id_clinica };
  }
  const group = await create('GrupoClinica', { nombre_grupo: 'BS · DEMO aislada', ads_assignment_mode: 'manual', web_assignment_mode: 'manual' });
  const cm = new Map(), dm = new Map(), rm = new Map(), em = new Map(), tm = new Map(), ctm = new Map();
  const hours = async (model, where) => {
    for (let dia_semana = 1; dia_semana <= 5; dia_semana++) await create(model, { ...where, dia_semana, hora_inicio: '09:00', hora_fin: '20:00', activo: true });
  };
  for (const [id, name, areas] of [[72, 'BS Medical', ['estetica','nutricion','psicologia','general']], [66, 'BS Capilar', ['capilar','estetica']]]) {
    const clinic = await create('Clinica', { nombre_clinica: `${name} · DEV`, grupoClinicaId: group.id_grupo, estado_clinica: true,
      equipment_booking_enabled: true, descripcion: 'Demostración: catálogo real, personas y citas ficticias. Sin envíos externos.',
      configuracion: { timezone: 'Europe/Madrid', disciplinas: areas, qa_demo: { key: KEY, synthetic_data_only: true } } });
    cm.set(id, clinic.id_clinica);
    await require('../../services/medicalAreaContracts.service').initializeClinic(clinic.id_clinica, { actorId: 1, transaction: tx });
    await create('UsuarioClinica', { id_usuario: 1, id_clinica: clinic.id_clinica, rol_clinica: 'propietario', estado_invitacion: 'aceptada' });
    await hours('ClinicaHorario', { clinica_id: clinic.id_clinica });
  }
  const staffIds = [...new Set(s.doctors.map(d => d.doctor_id))];
  for (const [i, id] of staffIds.entries()) {
    const row = await create('Usuario', { email_usuario: `dev.bs.reception.${i + 1}@example.invalid`, nombre: `Profesional BS ${i + 1}`, apellidos: 'Ficticio',
      password_usuario: null, isProfesional: true, notas_usuario: KEY });
    dm.set(id, row.id_usuario);
  }
  for (const d of s.doctors) {
    const dc = await create('DoctorClinica', { doctor_id: dm.get(d.doctor_id), clinica_id: cm.get(d.clinica_id), ...pick(d, 'rol_en_clinica recibe_citas activo') });
    await create('UsuarioClinica', { id_usuario: dm.get(d.doctor_id), id_clinica: cm.get(d.clinica_id), rol_clinica: 'personaldeclinica', subrol_clinica: /doctor|médic/i.test(d.rol_en_clinica || '') ? 'Doctores' : 'Auxiliares y enfermeros', estado_invitacion: 'aceptada' });
    if (d.activo && d.recibe_citas) await hours('DoctorHorario', { doctor_clinica_id: dc.id });
  }
  for (const r of s.rooms) {
    const row = await create('Instalacion', { ...pick(r, 'nombre tipo piso capacidad activo requiere_preparacion tiempo_preparacion_minutos default_duracion_minutos orden_visualizacion'),
      clinica_id: cm.get(r.clinica_id), descripcion: KEY, color: '#64748b', profesionales_permitidos: ids(r.profesionales_permitidos, dm) });
    rm.set(r.id, row.id);
    if (r.activo) await hours('InstalacionHorario', { instalacion_id: row.id });
  }
  for (const a of s.aliases) await create('InstallationPhysicalAlias', { installation_id: rm.get(a.installation_id), canonical_installation_id: rm.get(a.canonical_installation_id), group_id: group.id_grupo });
  for (const e of s.equipment) {
    const row = await create('BookingEquipment', { ...pick(e, 'name family_key mobility status turnaround_minutes'), aliases: j(e.aliases),
      owner_clinic_id: cm.get(e.owner_clinic_id), group_id: group.id_grupo, home_installation_id: e.home_installation_id ? rm.get(e.home_installation_id) : null });
    em.set(e.id, row.id);
  }
  for (const c of s.equipmentClinics) await create('BookingEquipmentClinic', { equipment_id: em.get(c.equipment_id), clinic_id: cm.get(c.clinic_id) });
  for (const p of s.policies) await create('BookingEquipmentRoomPolicy', { installation_id: rm.get(p.installation_id), mode: p.mode, equipment_ids: ids(p.equipment_ids, em) });
  for (const t of s.treatments) {
    const config = j(t.clinical_config) || {};
    const clean = { ...pick(config, 'medical_area_code catalog_status product_type price_profile booking_mode fiscal_mapping_pending quantity_duration'), qa_demo: KEY };
    if (config.booking_profile) clean.booking_profile = { ...config.booking_profile, phases: config.booking_profile.phases.map(p => ({
      ...p, installation_ids: ids(p.installation_ids, rm), professionals: { ...p.professionals,
        ids: ids(p.professionals?.ids, dm), preferred_id: p.professionals?.preferred_id ? dm.get(p.professionals.preferred_id) : null },
      ...(p.equipment_requirements ? { equipment_requirements: p.equipment_requirements.map(e => ({ ...e, equipment_ids: ids(e.equipment_ids, em) })) } : {}),
    })) };
    const row = await create('Tratamiento', { ...pick(t, 'nombre codigo disciplina especialidad categoria duracion_min precio_base sesiones_defecto requiere_pieza requiere_zona activo asignacion_instalacion_tipo tipo_instalacion_requerida'),
      descripcion: 'Catálogo de BS para pruebas aisladas. No contiene datos de pacientes.', origen: 'clinica', clinica_id: cm.get(t.clinica_id),
      clinical_config: clean, instalaciones_habilitadas: ids(t.instalaciones_habilitadas, rm) });
    tm.set(t.id_tratamiento, row.id_tratamiento);
  }
  for (const p of s.programs) await create('TreatmentProgram', { ...pick(p, 'name kind status total_price'), clinic_id: cm.get(p.clinic_id), public_id: randomUUID(),
    cadence: j(p.cadence), appointments: j(p.appointments).map(a => ({ ...a, treatment_ids: ids(a.treatment_ids, tm) })),
    notes: 'Copia de configuración para DEV. Conserva el estado de revisión del catálogo de origen.', created_by: 1, updated_by: 1 });
  for (const t of s.templates) {
    const row = await create('ClinicConsentTemplate', { ...pick(t, 'catalog_key name description purpose status blocking_policy validity_mode is_default requires_patient_signature requires_representative_when_minor requires_professional_signature'),
      clinic_id: cm.get(t.clinic_id), public_id: `ctpl_${randomUUID()}`, created_by: 1 });
    ctm.set(t.id, row.id);
  }
  for (const v of s.versions) await create('ClinicConsentTemplateVersion', { ...pick(v, 'version locale title body_html status published_at'),
    clinic_template_id: ctm.get(v.clinic_template_id), body_json: j(v.body_json), variable_schema: j(v.variable_schema), created_by: 1 });
  for (const r of s.requirements) {
    assert(!r.catalog_template_id, 'Catalog requirement needs an explicit template copy');
    await create('TreatmentConsentRequirement', { ...pick(r, 'requirement_scope condition_key required blocking_policy sort_order'), tratamiento_id: tm.get(r.tratamiento_id),
      clinica_id: cm.get(r.clinica_id || s.treatments.find(t => t.id_tratamiento === r.tratamiento_id).clinica_id), clinic_template_id: ctm.get(r.clinic_template_id) });
  }
  for (const p of s.protocols) await create('TreatmentProtocol', { ...pick(p, 'title kind status version content'), clinic_id: cm.get(p.clinic_id),
    treatment_ids: ids(p.treatment_ids, tm), source: 'Configuración BS · copia de prueba DEV', created_by: 1, updated_by: 1 });
  for (let i = 1; i <= 6; i++) {
    const patient = await create('Paciente', { public_id: `pac_bs_reception_demo_${i}`, clinica_id: cm.get(i <= 4 ? 72 : 66),
      nombre: `Paciente BS ${i}`, apellidos: 'Ficticio', paciente_conocido: true, idioma_preferido: 'es', antecedentes: 'Paciente ficticio de pruebas.',
      fecha_nacimiento: '1990-01-01', telefono_movil: null, email: null, dni: null });
    await create('PacienteClinica', { paciente_id: patient.id_paciente, clinica_id: patient.clinica_id, es_principal: true });
  }
  return { clinicId: cm.get(72), capilarClinicId: cm.get(66), treatments: tm.size, programs: s.programs.length, rooms: rm.size,
    equipment: em.size, templates: ctm.size, protocols: s.protocols.length, fictitiousStaff: dm.size, fictitiousPatients: 6 };
}

async function main(mode) {
  assert(['--rehearse','--apply'].includes(mode));
  require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated'); assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  assert.equal(process.env.QA_BS_RECEPTION_WRITES, KEY);
  const s = await source();
  const log = console.log; let db; try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  let tx;
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    tx = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    const result = await seed(db, s, tx);
    if (mode === '--apply') await tx.commit(); else await tx.rollback();
    console.log(JSON.stringify({ ...result, committed: mode === '--apply', source_read_only: true, no_real_patients: true }));
  } finally { if (tx && !tx.finished) await tx.rollback(); await db.sequelize.close(); }
}
if (require.main === module) main(process.argv[2]).catch(e => { console.error(JSON.stringify({ code: e.code || e.name, message: e.message })); process.exitCode = 1; });
module.exports = { KEY, seed };
