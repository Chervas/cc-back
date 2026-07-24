'use strict';

const crypto = require('crypto');

const variableSchemaBase = {
  variables: [
    { token: '{{paciente.nombre_completo}}', label: 'Paciente' },
    { token: '{{paciente.documento}}', label: 'Documento' },
    { token: '{{clinica.nombre}}', label: 'Clínica' },
    { token: '{{clinica.direccion}}', label: 'Dirección clínica' },
    { token: '{{tratamiento.nombre}}', label: 'Tratamiento' },
    { token: '{{cita.fecha}}', label: 'Fecha de cita' },
    { token: '{{profesional.nombre}}', label: 'Profesional' },
  ],
};

const templates = [
  {
    catalog_key: 'cc_nutricion_valoracion_antropometrica_v1',
    name: 'Consentimiento informado de valoración nutricional y antropometría',
    description: 'Documento para consulta nutricional, mediciones corporales y estudio antropométrico.',
    purpose: 'clinical',
    blocking_policy: 'soft',
    validity_mode: 'treatment_episode',
    is_generic: false,
    disciplines: ['nutricion'],
    requires_professional_signature: true,
    signing_timing: 'first_visit',
    title: 'Consentimiento informado de valoración nutricional y antropometría',
    body_html: [
      '<h2>Consentimiento informado de valoración nutricional y antropometría</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>Se me ha explicado que la valoración nutricional puede incluir entrevista clínica, revisión de hábitos, antecedentes relevantes, objetivos, peso, talla, perímetros, pliegues cutáneos, diámetros corporales y otros registros necesarios para elaborar seguimiento e informes.</p>',
      '<p>Entiendo que las mediciones son orientativas y dependen de la técnica, el momento de la visita y mi evolución. No sustituyen pruebas diagnósticas médicas cuando sean necesarias.</p>',
      '<p>Autorizo la realización de estas mediciones, el registro en mi historia clínica y su uso para seguimiento asistencial dentro de la clínica.</p>',
      '<p>He podido resolver dudas y sé que puedo retirar mi autorización para nuevas mediciones no realizadas.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_nutricion_plan_alimentario_v1',
    name: 'Consentimiento para plan nutricional y seguimiento',
    description: 'Uso asistencial de pautas alimentarias, objetivos y revisiones de evolución.',
    purpose: 'clinical',
    blocking_policy: 'soft',
    validity_mode: 'treatment_plan',
    is_generic: false,
    disciplines: ['nutricion'],
    requires_professional_signature: true,
    signing_timing: 'before_treatment',
    title: 'Consentimiento para plan nutricional y seguimiento',
    body_html: [
      '<h2>Consentimiento para plan nutricional y seguimiento</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Tratamiento:</strong> {{tratamiento.nombre}}</p>',
      '<p>Se me ha informado de que el plan nutricional se adapta a los datos declarados, mediciones, preferencias, objetivos y evolución observada durante las visitas.</p>',
      '<p>Entiendo que debo comunicar enfermedades, medicación, alergias, embarazo, lactancia, trastornos de la conducta alimentaria, síntomas o cambios relevantes antes de seguir recomendaciones nutricionales.</p>',
      '<p>El seguimiento puede requerir ajustes. Los resultados dependen de la adherencia, contexto clínico y controles indicados. Si aparecen síntomas o dudas, contactaré con el profesional o con mi médico.</p>',
      '<p>Autorizo la elaboración y seguimiento del plan dentro de mi historia clínica.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_nutricion_imagen_medicion_clinica_v1',
    name: 'Autorización de imágenes clínicas para nutrición',
    description: 'Imágenes privadas para evolución corporal y comparación clínica en nutrición.',
    purpose: 'clinical_image',
    blocking_policy: 'optional',
    validity_mode: 'treatment_episode',
    is_generic: false,
    disciplines: ['nutricion'],
    requires_professional_signature: false,
    signing_timing: 'manual',
    title: 'Autorización de imágenes clínicas para nutrición',
    body_html: [
      '<h2>Autorización de imágenes clínicas para nutrición</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>Autorizo la toma y conservación de imágenes privadas para documentar mi evolución corporal dentro del seguimiento nutricional.</p>',
      '<p>Estas imágenes se incorporarán a mi historia clínica y solo serán visibles para el equipo asistencial autorizado. No autorizo su uso en redes sociales, publicidad, web, docencia externa ni casos de éxito sin un consentimiento adicional separado.</p>',
      '<p>Puedo rechazar esta autorización sin que ello impida recibir asistencia nutricional.</p>',
      '<p>Firma del paciente o representante legal:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_estetica_laser_luz_pulsada_v1',
    name: 'Consentimiento informado de láser o luz pulsada',
    description: 'Plantilla para tratamientos con láser, IPL u otros dispositivos de energía.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'single_act',
    is_generic: false,
    disciplines: ['estetica'],
    requires_professional_signature: true,
    signing_timing: 'at_least_24h_before',
    title: 'Consentimiento informado de láser o luz pulsada',
    body_html: [
      '<h2>Consentimiento informado de láser o luz pulsada</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Tratamiento:</strong> {{tratamiento.nombre}}</p>',
      '<p>Se me ha explicado que el tratamiento utiliza energía lumínica o láser con finalidad estética o dermatológica, según indicación profesional y parámetros ajustados a mi caso.</p>',
      '<p><strong>Riesgos y efectos posibles:</strong> dolor, enrojecimiento, edema, quemadura, ampolla, costra, hiperpigmentación, hipopigmentación, cicatriz, reactivación de herpes, resultado incompleto o necesidad de varias sesiones.</p>',
      '<p>He comunicado medicación fotosensibilizante, embarazo, lactancia, exposición solar reciente, bronceado, antecedentes cutáneos o cualquier dato relevante.</p>',
      '<p>Conozco cuidados previos y posteriores, alternativas y posibilidad de no realizar el tratamiento. Acepto su realización tras haber podido preguntar.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_estetica_peeling_quimico_v1',
    name: 'Consentimiento informado de peeling químico',
    description: 'Plantilla para peeling superficial, medio o combinado.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'single_act',
    is_generic: false,
    disciplines: ['estetica'],
    requires_professional_signature: true,
    signing_timing: 'before_treatment',
    title: 'Consentimiento informado de peeling químico',
    body_html: [
      '<h2>Consentimiento informado de peeling químico</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>Se me ha informado de que el peeling químico consiste en aplicar sustancias sobre la piel para producir una renovación controlada, con profundidad y objetivo adaptados a mi caso.</p>',
      '<p><strong>Riesgos y efectos posibles:</strong> escozor, enrojecimiento, descamación, inflamación, costras, hiperpigmentación, hipopigmentación, infección, brote acneico, reactivación de herpes, cicatriz o resultado inferior al esperado.</p>',
      '<p>Conozco las indicaciones de fotoprotección, cuidados posteriores, contraindicaciones y necesidad de avisar ante dolor intenso, secreción, fiebre u otros signos de alarma.</p>',
      '<p>Declaro haber recibido información suficiente y acepto el procedimiento.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_estetica_imagen_antes_despues_v1',
    name: 'Autorización de imágenes clínicas antes y después',
    description: 'Imágenes privadas para comparación clínica en tratamientos estéticos.',
    purpose: 'clinical_image',
    blocking_policy: 'soft',
    validity_mode: 'treatment_episode',
    is_generic: false,
    disciplines: ['estetica'],
    requires_professional_signature: false,
    signing_timing: 'before_treatment',
    title: 'Autorización de imágenes clínicas antes y después',
    body_html: [
      '<h2>Autorización de imágenes clínicas antes y después</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Tratamiento:</strong> {{tratamiento.nombre}}</p>',
      '<p>Autorizo la toma de fotografías o vídeos privados para documentar el estado inicial, planificación, evolución y comparación antes/después de mi tratamiento estético.</p>',
      '<p>Estas imágenes forman parte de mi historia clínica y no podrán usarse en redes sociales, web, publicidad, docencia externa ni material comercial sin una autorización específica adicional.</p>',
      '<p>Entiendo que puedo limitar o retirar esta autorización para nuevas imágenes, sin afectar a la asistencia ya prestada.</p>',
      '<p>Firma del paciente o representante legal:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_capilar_prp_mesoterapia_v1',
    name: 'Consentimiento informado de PRP o mesoterapia capilar',
    description: 'Plantilla para infiltraciones capilares, PRP, vitaminas o mesoterapia.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'single_act',
    is_generic: false,
    disciplines: ['capilar'],
    requires_professional_signature: true,
    signing_timing: 'before_treatment',
    title: 'Consentimiento informado de PRP o mesoterapia capilar',
    body_html: [
      '<h2>Consentimiento informado de PRP o mesoterapia capilar</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Tratamiento:</strong> {{tratamiento.nombre}}</p>',
      '<p>Se me ha explicado que el tratamiento consiste en infiltraciones en cuero cabelludo con PRP, vitaminas, fármacos u otros productos indicados por el profesional para mejorar o estabilizar la salud capilar.</p>',
      '<p><strong>Riesgos y efectos posibles:</strong> dolor, sangrado, hematoma, inflamación, infección, reacción local, mareo, resultado insuficiente, necesidad de varias sesiones y controles evolutivos.</p>',
      '<p>He comunicado alergias, medicación, enfermedades, embarazo o lactancia si procede. Conozco alternativas, cuidados posteriores y la posibilidad de no realizar el tratamiento.</p>',
      '<p>Declaro haber podido resolver dudas y autorizo el procedimiento.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_capilar_imagen_evolucion_v1',
    name: 'Autorización de fotografías clínicas capilares',
    description: 'Fotografías privadas de zonas capilares para diagnóstico y evolución.',
    purpose: 'clinical_image',
    blocking_policy: 'soft',
    validity_mode: 'treatment_episode',
    is_generic: false,
    disciplines: ['capilar'],
    requires_professional_signature: false,
    signing_timing: 'before_treatment',
    title: 'Autorización de fotografías clínicas capilares',
    body_html: [
      '<h2>Autorización de fotografías clínicas capilares</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>Autorizo la toma de fotografías privadas del cuero cabelludo, zonas donante/receptora o áreas de alopecia para diagnóstico, planificación, seguimiento evolutivo y comparación clínica.</p>',
      '<p>Estas imágenes se guardarán en mi historia clínica y no se utilizarán para publicidad, redes sociales, web, casos de éxito ni docencia externa sin autorización separada.</p>',
      '<p>Firma del paciente o representante legal:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_financiacion_pago_aplazado_v1',
    name: 'Información y autorización para financiación o pago aplazado',
    description: 'Documento genérico para preparar financiación, pago aplazado o cesión mínima a entidad financiera.',
    purpose: 'financial',
    blocking_policy: 'soft',
    validity_mode: 'manual',
    is_generic: true,
    disciplines: [],
    requires_professional_signature: false,
    signing_timing: 'manual',
    title: 'Información y autorización para financiación o pago aplazado',
    body_html: [
      '<h2>Información y autorización para financiación o pago aplazado</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>Solicito información o tramitación de una modalidad de pago aplazado o financiación vinculada al presupuesto o tratamiento indicado por la clínica.</p>',
      '<p>Autorizo a la clínica a registrar los datos administrativos necesarios para preparar la solicitud y, si procede, remitirlos a la entidad financiera o proveedor de pago que se me indique, siempre con la información contractual correspondiente.</p>',
      '<p>Entiendo que la aprobación, intereses, gastos, plazos, documentación requerida y condiciones económicas dependen de la entidad financiera o del acuerdo concreto que acepte expresamente.</p>',
      '<p>Esta autorización no confirma la contratación de financiación ni sustituye la firma del contrato financiero que corresponda.</p>',
      '<p>Firma del paciente o representante legal:</p>',
    ].join('\n'),
  },
];

function publicId() {
  return `cadmin_${crypto.randomBytes(10).toString('hex')}`;
}

function buildVariableSchema(template) {
  return {
    ...variableSchemaBase,
    signing_timing: {
      mode: template.signing_timing || 'before_treatment',
      recommended_min_hours_before: template.signing_timing === 'at_least_24h_before' ? 24 : null,
    },
    clinical_policy: {
      signing_timing: template.signing_timing || 'before_treatment',
      requires_explanation_statement: template.requires_professional_signature === true,
    },
    source: {
      type: 'clinicaclick_catalog',
      note: 'Plantilla base redactada por Clinicaclick para demo/operativa; debe revisarse por asesor legal de la clínica antes de uso definitivo.',
    },
  };
}

async function upsertTemplate(queryInterface, Sequelize, item, now) {
  const existing = await queryInterface.sequelize.query(
    'SELECT id FROM ConsentTemplateCatalogs WHERE catalog_key = :catalogKey LIMIT 1',
    {
      replacements: { catalogKey: item.catalog_key },
      type: Sequelize.QueryTypes.SELECT,
    }
  );

  let catalogId = existing[0]?.id || null;
  const catalogRow = {
    catalog_key: item.catalog_key,
    name: item.name,
    description: item.description,
    purpose: item.purpose,
    status: 'active',
    blocking_policy: item.blocking_policy,
    validity_mode: item.validity_mode,
    is_generic: item.is_generic,
    requires_patient_signature: true,
    requires_representative_when_minor: true,
    requires_professional_signature: item.requires_professional_signature,
    created_by: 1,
    updatedAt: now,
  };

  if (catalogId) {
    await queryInterface.bulkUpdate('ConsentTemplateCatalogs', catalogRow, { id: catalogId });
  } else {
    await queryInterface.bulkInsert('ConsentTemplateCatalogs', [{
      ...catalogRow,
      public_id: publicId(),
      createdAt: now,
    }]);
    const created = await queryInterface.sequelize.query(
      'SELECT id FROM ConsentTemplateCatalogs WHERE catalog_key = :catalogKey LIMIT 1',
      {
        replacements: { catalogKey: item.catalog_key },
        type: Sequelize.QueryTypes.SELECT,
      }
    );
    catalogId = created[0]?.id || null;
  }

  if (!catalogId) return;

  await queryInterface.bulkDelete('ConsentTemplateCatalogDisciplines', { catalog_id: catalogId });
  if (item.disciplines.length) {
    await queryInterface.bulkInsert('ConsentTemplateCatalogDisciplines', item.disciplines.map((disciplina_code) => ({
      catalog_id: catalogId,
      disciplina_code,
      createdAt: now,
      updatedAt: now,
    })));
  }

  const versions = await queryInterface.sequelize.query(
    'SELECT id FROM ConsentTemplateCatalogVersions WHERE catalog_id = :catalogId AND locale = "es" ORDER BY version DESC, id DESC LIMIT 1',
    {
      replacements: { catalogId },
      type: Sequelize.QueryTypes.SELECT,
    }
  );

  const versionRow = {
    title: item.title,
    body_json: null,
    body_html: item.body_html,
    variable_schema: JSON.stringify(buildVariableSchema(item)),
    status: 'published',
    published_at: now,
    created_by: 1,
    updatedAt: now,
  };

  if (versions[0]?.id) {
    await queryInterface.bulkUpdate('ConsentTemplateCatalogVersions', versionRow, { id: versions[0].id });
  } else {
    await queryInterface.bulkInsert('ConsentTemplateCatalogVersions', [{
      ...versionRow,
      catalog_id: catalogId,
      version: 1,
      locale: 'es',
      createdAt: now,
    }]);
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    for (const item of templates) {
      await upsertTemplate(queryInterface, Sequelize, item, now);
    }
  },

  async down(queryInterface, Sequelize) {
    const keys = templates.map((item) => item.catalog_key);
    const catalogs = await queryInterface.sequelize.query(
      'SELECT id FROM ConsentTemplateCatalogs WHERE catalog_key IN (:keys)',
      {
        replacements: { keys },
        type: Sequelize.QueryTypes.SELECT,
      }
    );
    const ids = catalogs.map((item) => item.id);
    if (!ids.length) return;

    await queryInterface.bulkDelete('ConsentTemplateCatalogDisciplines', { catalog_id: ids });
    await queryInterface.bulkDelete('ConsentTemplateCatalogTreatments', { catalog_id: ids });
    await queryInterface.bulkDelete('ConsentTemplateCatalogVersions', { catalog_id: ids });
    await queryInterface.bulkDelete('ConsentTemplateCatalogs', { id: ids });
  },
};
