'use strict';

require('dotenv').config();

const originalConsoleLog = console.log;
console.log = () => {};
const db = require('../../../models');
console.log = originalConsoleLog;

const consentimientosService = require('../../services/consentimientos.service');

const DEFAULT_CLINIC_IDS = [66, 72, 74, 68, 77];
const CATALOG_KEYS = [
  'cc_nutricion_valoracion_antropometrica_v1',
  'cc_nutricion_plan_alimentario_v1',
  'cc_nutricion_imagen_medicion_clinica_v1',
  'cc_estetica_laser_luz_pulsada_v1',
  'cc_estetica_peeling_quimico_v1',
  'cc_estetica_imagen_antes_despues_v1',
  'cc_capilar_prp_mesoterapia_v1',
  'cc_capilar_imagen_evolucion_v1',
  'cc_financiacion_pago_aplazado_v1',
];

function parseClinicIds() {
  const raw = process.env.CC_DEMO_CONSENT_LIBRARY_CLINIC_IDS || '';
  const ids = raw
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
  return ids.length ? ids : DEFAULT_CLINIC_IDS;
}

function normalizeDisciplines(config) {
  if (!config || typeof config !== 'object') return [];
  const source = Array.isArray(config.disciplinas)
    ? config.disciplinas
    : (config.disciplina ? [config.disciplina] : []);
  return Array.from(new Set(source.map((item) => String(item || '').trim()).filter(Boolean))).sort();
}

async function listCatalogRows() {
  const rows = await db.ConsentTemplateCatalog.findAll({
    where: { catalog_key: { [db.Sequelize.Op.in]: CATALOG_KEYS } },
    include: [
      { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines', required: false },
      { model: db.ConsentTemplateCatalogVersion, as: 'versions', required: false },
    ],
    order: [['catalog_key', 'ASC']],
  });

  return rows.map((row) => {
    const plain = row.toJSON();
    return {
      id: plain.id,
      catalog_key: plain.catalog_key,
      name: plain.name,
      purpose: plain.purpose,
      status: plain.status,
      is_generic: plain.is_generic === true,
      disciplines: (plain.disciplines || []).map((item) => item.disciplina_code).sort(),
      version: (plain.versions || []).sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0]?.version || null,
    };
  });
}

async function listClinicCopies(clinicIds) {
  const rows = await db.ClinicConsentTemplate.findAll({
    where: { clinic_id: { [db.Sequelize.Op.in]: clinicIds } },
    include: [
      {
        model: db.ConsentTemplateCatalog,
        as: 'sourceCatalog',
        required: true,
        where: { catalog_key: { [db.Sequelize.Op.in]: CATALOG_KEYS } },
        include: [
          { model: db.ConsentTemplateCatalogDiscipline, as: 'disciplines', required: false },
        ],
      },
    ],
    order: [['clinic_id', 'ASC'], ['name', 'ASC']],
  });

  return rows.map((row) => {
    const plain = row.toJSON();
    return {
      id: plain.id,
      clinic_id: plain.clinic_id,
      name: plain.name,
      status: plain.status,
      purpose: plain.purpose,
      source_catalog_key: plain.sourceCatalog?.catalog_key || null,
      disciplines: (plain.sourceCatalog?.disciplines || []).map((item) => item.disciplina_code).sort(),
    };
  });
}

async function main() {
  const clinicIds = parseClinicIds();
  const clinics = await db.Clinica.findAll({
    where: { id_clinica: { [db.Sequelize.Op.in]: clinicIds } },
    attributes: ['id_clinica', 'nombre_clinica', 'configuracion'],
    order: [['id_clinica', 'ASC']],
    raw: true,
  });

  const beforeCopies = await listClinicCopies(clinicIds);
  const syncResults = [];
  for (const clinic of clinics) {
    const result = await consentimientosService.syncClinicTemplatesFromCatalog(clinic.id_clinica, 1);
    syncResults.push({
      clinic_id: clinic.id_clinica,
      clinic_name: clinic.nombre_clinica,
      disciplines: normalizeDisciplines(clinic.configuracion),
      created_count: result.created_count,
      created_names: (result.items || []).map((item) => item.name).sort(),
    });
  }

  const catalog = await listCatalogRows();
  const afterCopies = await listClinicCopies(clinicIds);
  const copiesByClinic = clinics.map((clinic) => ({
    clinic_id: clinic.id_clinica,
    clinic_name: clinic.nombre_clinica,
    disciplines: normalizeDisciplines(clinic.configuracion),
    templates: afterCopies
      .filter((item) => item.clinic_id === clinic.id_clinica)
      .map((item) => ({
        name: item.name,
        purpose: item.purpose,
        status: item.status,
        source_catalog_key: item.source_catalog_key,
        disciplines: item.disciplines,
      })),
  }));

  const payload = {
    generated_at: new Date().toISOString(),
    mode: 'dev_demo_seed',
    note: 'No contiene URLs tokenizadas ni datos clínicos reales. Las plantillas son textos base Clinicaclick para demo/revisión legal, no copias de terceros.',
    catalog_count: catalog.length,
    catalog,
    before_copy_count: beforeCopies.length,
    after_copy_count: afterCopies.length,
    sync_results: syncResults,
    copies_by_clinic: copiesByClinic,
    demo_urls: copiesByClinic.map((clinic) => ({
      clinic_id: clinic.clinic_id,
      clinic_name: clinic.clinic_name,
      url: `http://localhost:4203/consentimientos?tab=templates&clinica_id=${clinic.clinic_id}`,
      expected_templates: clinic.templates.length,
    })),
  };

  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
