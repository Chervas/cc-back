'use strict';

const { randomUUID } = require('crypto');
const db = require('../../models');

const { AdminCampaignPlaybook } = db;

const dryRun = process.argv.includes('--dry-run');

const baseDestinationPolicy = {
  clinic_website_default: true,
  specific_url_allowed: true,
  subtree_recommended: true,
  landing_future: true,
};

const baseMeasurementProfile = {
  first_party: true,
  channel_native: true,
  business_outcomes: true,
  remarketing: false,
  ad_calls: false,
};

const baseAutomationStrategy = {
  mode: 'inherit_recommendation',
  template_key: null,
  template_version: null,
  reactivation_preset: null,
};

const baseReviewPolicy = {
  managed_review_required: true,
  client_approval_required: false,
};

const aestheticPlaybooks = [
  {
    catalog_key: 'new_patients_estetica_armonizacion_facial',
    display_name: 'Armonización facial',
    family_key: 'facial_harmonization',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['google_ads', 'meta_ads'],
    recommended_budget_min: 450,
    recommended_budget_max: 1500,
    notes_internal: [
      'Playbook paraguas para combinaciones tipo labios + neuromoduladores, ácido hialurónico, bioestimulación e hilos.',
      'No fuerza un SKU clínico concreto; se usa para campañas con intención estética facial combinada.',
      'Copy recomendado: enfoque en valoración personalizada, naturalidad y plan facial; evitar promesas clínicas absolutas.',
    ].join('\n'),
  },
  {
    catalog_key: 'new_patients_estetica_labios',
    display_name: 'Labios y perfilado facial',
    family_key: 'lips_contouring',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['meta_ads', 'google_ads'],
    recommended_budget_min: 250,
    recommended_budget_max: 900,
    notes_internal: [
      'Para campañas centradas en aumento/perfilado de labios, hidratación labial y relleno suave.',
      'Encaja con tratamientos de ácido hialurónico labial aunque cada clínica use marcas o viales distintos.',
    ].join('\n'),
  },
  {
    catalog_key: 'new_patients_estetica_neuromoduladores',
    display_name: 'Neuromoduladores y arrugas de expresión',
    family_key: 'neuromodulators_expression_lines',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['google_ads', 'meta_ads'],
    recommended_budget_min: 300,
    recommended_budget_max: 900,
    notes_internal: [
      'Para campañas de arrugas de expresión, toxina botulínica/neuromoduladores y retoques asociados.',
      'Usar nombre comercial solo si la clínica lo comunica de forma autorizada; por defecto usar “neuromoduladores”.',
    ].join('\n'),
  },
  {
    catalog_key: 'new_patients_estetica_acido_hialuronico',
    display_name: 'Rellenos con ácido hialurónico',
    family_key: 'hyaluronic_fillers',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['google_ads', 'meta_ads'],
    recommended_budget_min: 350,
    recommended_budget_max: 1200,
    notes_internal: [
      'Para campañas de rellenos faciales con ácido hialurónico: labios, pómulos, surcos, volumen o hidratación.',
      'Sirve como familia cuando la clínica tiene múltiples viales/marcas y no conviene exponer cada SKU.',
    ].join('\n'),
  },
  {
    catalog_key: 'new_patients_estetica_calidad_piel',
    display_name: 'Calidad de piel y tratamientos faciales',
    family_key: 'skin_quality_facial',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['meta_ads', 'google_ads'],
    recommended_budget_min: 250,
    recommended_budget_max: 850,
    notes_internal: [
      'Agrupa peelings, limpiezas, mesoterapia, PRP, carboxiterapia facial, Vitaplasma y protocolos luminosidad/detox.',
      'Útil para campañas estacionales o packs de preparación de eventos.',
    ].join('\n'),
  },
  {
    catalog_key: 'new_patients_estetica_corporal',
    display_name: 'Estética corporal y remodelación',
    family_key: 'body_contouring',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['google_ads', 'meta_ads'],
    recommended_budget_min: 400,
    recommended_budget_max: 1300,
    notes_internal: [
      'Para Cyclone, radiofrecuencia, presoterapia, carboxiterapia, criolipólisis, Indiba, drenaje y bonos corporales.',
      'Los packs full body se tratan aquí como campaña paraguas, no como tratamiento específico.',
    ].join('\n'),
  },
  {
    catalog_key: 'new_patients_estetica_hilos_bioestimulacion',
    display_name: 'Hilos tensores y bioestimulación',
    family_key: 'threads_biostimulation',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['google_ads', 'meta_ads'],
    recommended_budget_min: 350,
    recommended_budget_max: 1100,
    notes_internal: [
      'Para hilos tensores, hidroxiapatita cálcica, inductores de colágeno y tratamientos de firmeza facial.',
      'Puede convivir con Armonización facial; se usa cuando la campaña está claramente centrada en firmeza/rejuvenecimiento.',
    ].join('\n'),
  },
  {
    catalog_key: 'new_patients_estetica_cirugia',
    display_name: 'Cirugía estética',
    family_key: 'aesthetic_surgery',
    channels_supported: ['google_ads', 'meta_ads'],
    channels_default: ['google_ads'],
    recommended_budget_min: 700,
    recommended_budget_max: 3000,
    notes_internal: [
      'Para blefaroplastia, rinoplastia, mamoplastia, abdominoplastia, lifting, otoplastia y cirugías similares.',
      'Preferir Google Ads y landing específica; Meta solo como apoyo de marca/consideración si la política lo permite.',
    ].join('\n'),
  },
];

const testPlaybookKeys = [
  'new_patients_campana_admin_test',
  'new_patients_campana_admin_test_2',
];

function playbookPayload(playbook) {
  return {
    catalog_key: playbook.catalog_key,
    display_name: playbook.display_name,
    objective_id: 'new_patients',
    promotion_kind: 'generic_campaign',
    treatment_id: null,
    area_medica: 'estetica',
    family_key: playbook.family_key,
    status: 'active',
    channels_supported: playbook.channels_supported,
    channels_default: playbook.channels_default,
    recommended_budget_min: playbook.recommended_budget_min,
    recommended_budget_max: playbook.recommended_budget_max,
    destination_policy: baseDestinationPolicy,
    measurement_profile: baseMeasurementProfile,
    automation_strategy: baseAutomationStrategy,
    template_bundle_refs: [],
    review_policy: baseReviewPolicy,
    notes_internal: playbook.notes_internal,
  };
}

async function main() {
  const created = [];
  const updated = [];
  const archived = [];

  for (const catalogKey of testPlaybookKeys) {
    const existing = await AdminCampaignPlaybook.findOne({ where: { catalog_key: catalogKey } });
    if (!existing || existing.status === 'archived') continue;

    archived.push(catalogKey);
    if (!dryRun) {
      await existing.update({
        status: 'archived',
        notes_internal: [
          existing.notes_internal || '',
          'Archivado por seed-aesthetic-campaign-playbooks: era un playbook de prueba y no debe aparecer al cliente.',
        ].filter(Boolean).join('\n'),
      });
    }
  }

  for (const definition of aestheticPlaybooks) {
    const payload = playbookPayload(definition);
    const existing = await AdminCampaignPlaybook.findOne({ where: { catalog_key: payload.catalog_key } });

    if (existing) {
      updated.push(payload.catalog_key);
      if (!dryRun) {
        await existing.update(payload);
      }
    } else {
      created.push(payload.catalog_key);
      if (!dryRun) {
        await AdminCampaignPlaybook.create({
          id: randomUUID(),
          ...payload,
        });
      }
    }
  }

  console.log(JSON.stringify({
    dryRun,
    archived,
    created,
    updated,
    totalActiveAestheticPlaybooks: aestheticPlaybooks.length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
