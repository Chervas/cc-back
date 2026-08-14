'use strict';

const db = require('../../models');

const MARKER = 'clinicaclick_demo_patient_direction';
const TARGET_EMAIL = 'ana.franco@modmarketing.net';
const TARGET_CLINIC = 'BS Medical · DEMO';

const DEMO_LEADS = [
  { external_id: 'pd-demo-nuevo-1', nombre: 'Demo Laura consulta estética', status_lead: 'nuevo' },
  { external_id: 'pd-demo-nuevo-2', nombre: 'Demo Marcos valoración capilar', status_lead: 'nuevo' },
  { external_id: 'pd-demo-contactado-1', nombre: 'Demo Elena seguimiento', status_lead: 'contactado', num_contactos: 1 },
  { external_id: 'pd-demo-espera-1', nombre: 'Demo David pendiente de horario', status_lead: 'esperando_info', num_contactos: 2 },
  { external_id: 'pd-demo-citado-1', nombre: 'Demo Sara primera visita', status_lead: 'citado', num_contactos: 2 },
];

async function clean() {
  const removed = await db.LeadIntake.destroy({ where: { external_source: MARKER } });
  console.log(`[patient-direction-demo] ${removed} leads demo eliminados.`);
}

async function seed() {
  const [user, clinic] = await Promise.all([
    db.Usuario.findOne({ where: { email_usuario: TARGET_EMAIL } }),
    db.Clinica.findOne({ where: { nombre_clinica: TARGET_CLINIC } }),
  ]);
  if (!user) throw new Error(`No existe el usuario ${TARGET_EMAIL}`);
  if (!clinic) throw new Error(`No existe la clínica ${TARGET_CLINIC}`);

  const profile = await db.PatientDirectionProfile.findOne({ where: { user_id: user.id_usuario } });
  if (!profile?.is_active) throw new Error('Ana debe tener el perfil Director de pacientes activo antes del seed');

  const [setting] = await db.PatientDirectionSetting.findOrCreate({
    where: { clinic_id: clinic.id_clinica },
    defaults: {
      clinic_id: clinic.id_clinica,
      is_enabled: false,
      director_user_id: user.id_usuario,
      director_phone_asset_id: profile.whatsapp_phone_asset_id || null,
      clinic_phone_asset_id: null,
      default_successor_user_id: null,
      config: { demo_marker: MARKER },
    },
  });
  if (setting.director_user_id && Number(setting.director_user_id) !== Number(user.id_usuario)) {
    throw new Error('La clínica demo ya tiene otro Director de pacientes asignado');
  }
  if (!setting.director_user_id) {
    await setting.update({
      director_user_id: user.id_usuario,
      director_phone_asset_id: profile.whatsapp_phone_asset_id || null,
    });
  }

  for (const demo of DEMO_LEADS) {
    await db.LeadIntake.findOrCreate({
      where: { external_source: MARKER, external_id: demo.external_id },
      defaults: {
        clinica_id: clinic.id_clinica,
        channel: 'unknown',
        source: 'direct',
        source_detail: 'Datos sintéticos para QA del Director de pacientes',
        nombre: demo.nombre,
        telefono: null,
        email: null,
        notas: 'DEMO BORRABLE. No corresponde a una persona real y no permite envíos.',
        notas_internas: `Marcador de limpieza: ${MARKER}`,
        asignado_a: user.id_usuario,
        status_lead: demo.status_lead,
        num_contactos: demo.num_contactos || 0,
        consentimiento_canal: {},
        historial_contactos: [],
        external_source: MARKER,
        external_id: demo.external_id,
      },
    });
  }

  console.log(JSON.stringify({
    clinic_id: clinic.id_clinica,
    director_user_id: user.id_usuario,
    setting_enabled: Boolean(setting.is_enabled),
    leads: DEMO_LEADS.length,
    marker: MARKER,
  }, null, 2));
}

(async () => {
  if (process.argv.includes('--clean')) await clean();
  else await seed();
  await db.sequelize.close();
})().catch(async (error) => {
  console.error('[patient-direction-demo]', error);
  try { await db.sequelize.close(); } catch {}
  process.exit(1);
});
