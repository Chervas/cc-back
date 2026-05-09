'use strict';

const crypto = require('crypto');

const variableSchema = {
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
    catalog_key: 'cc_base_proteccion_datos_asistencia_v1',
    name: 'Información de protección de datos y asistencia sanitaria',
    description: 'Base genérica para primera asistencia: información RGPD, historia clínica y canales de contacto no comerciales.',
    purpose: 'data_protection',
    blocking_policy: 'hard',
    validity_mode: 'manual',
    is_generic: true,
    disciplines: [],
    requires_professional_signature: false,
    title: 'Información de protección de datos y asistencia sanitaria',
    body_html: [
      '<h2>Información de protección de datos y asistencia sanitaria</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Documento:</strong> {{paciente.documento}}</p>',
      '<p><strong>Centro:</strong> {{clinica.nombre}} · {{clinica.direccion}}</p>',
      '<p>La clínica informa al paciente de que sus datos personales, incluidos datos de salud, serán tratados para prestarle asistencia sanitaria, gestionar su historia clínica, organizar citas, emitir presupuestos, cumplir obligaciones legales y mantener comunicaciones necesarias sobre su atención.</p>',
      '<p>El paciente declara haber recibido esta información de forma clara y comprensible, y entiende que puede solicitar información adicional sobre responsable del tratamiento, derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad, así como sobre los canales habilitados para ejercerlos.</p>',
      '<p>Las comunicaciones comerciales, la cesión de datos no necesaria para la asistencia y el uso publicitario de imágenes requieren autorizaciones separadas y opcionales.</p>',
      '<p>Firma del paciente o representante legal:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_dental_ortodoncia_v1',
    name: 'Consentimiento informado de ortodoncia',
    description: 'Plantilla base dental para tratamientos de ortodoncia fija, removible o alineadores.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'treatment_plan',
    is_generic: false,
    disciplines: ['dental'],
    requires_professional_signature: true,
    title: 'Consentimiento informado de ortodoncia',
    body_html: [
      '<h2>Consentimiento informado de ortodoncia</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Documento:</strong> {{paciente.documento}}</p>',
      '<p><strong>Clínica:</strong> {{clinica.nombre}} · <strong>Profesional responsable:</strong> {{profesional.nombre}}</p>',
      '<p>Se ha informado al paciente sobre el tratamiento de ortodoncia propuesto, su finalidad funcional y estética, la duración estimada, la necesidad de revisiones periódicas y la importancia de la colaboración del paciente en higiene, uso de aparatología y asistencia a citas.</p>',
      '<p><strong>Riesgos y molestias posibles:</strong> dolor o presión inicial, rozaduras, movilidad transitoria, inflamación gingival, caries o manchas por higiene insuficiente, reabsorción radicular, descementado de aparatología, necesidad de ajustes del plan y recidiva si no se utiliza la retención indicada.</p>',
      '<p>Se han explicado alternativas razonables, incluida la no realización del tratamiento, y las consecuencias de no seguir las instrucciones clínicas. El paciente declara haber podido realizar preguntas y haberlas recibido contestadas.</p>',
      '<p>Este consentimiento queda vinculado al plan de tratamiento de ortodoncia y deberá revisarse si cambia de forma relevante la técnica, el estado clínico o los riesgos informados.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_dental_implantes_v1',
    name: 'Consentimiento informado de implantes dentales',
    description: 'Plantilla base para colocación de implantes dentales y cirugía asociada.',
    purpose: 'clinical',
    blocking_policy: 'hard',
    validity_mode: 'single_act',
    is_generic: false,
    disciplines: ['dental'],
    requires_professional_signature: true,
    title: 'Consentimiento informado de implantes dentales',
    body_html: [
      '<h2>Consentimiento informado de implantes dentales</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Documento:</strong> {{paciente.documento}}</p>',
      '<p><strong>Clínica:</strong> {{clinica.nombre}} · <strong>Tratamiento:</strong> {{tratamiento.nombre}} · <strong>Fecha prevista:</strong> {{cita.fecha}}</p>',
      '<p>Se ha explicado al paciente la colocación de implantes dentales como procedimiento quirúrgico destinado a sustituir piezas ausentes o servir de soporte protésico. La intervención puede requerir anestesia local, pruebas radiológicas, suturas, medicación y controles posteriores.</p>',
      '<p><strong>Riesgos frecuentes o relevantes:</strong> dolor, inflamación, hematoma, sangrado, infección, fracaso de osteointegración, pérdida del implante, alteración temporal o permanente de sensibilidad, lesión de estructuras anatómicas próximas, sinusitis, necesidad de regeneración ósea o procedimientos complementarios.</p>',
      '<p>Se han informado beneficios esperados, limitaciones, alternativas terapéuticas y consecuencias de no realizar el tratamiento. El paciente entiende que el resultado depende de su estado clínico, hábitos, higiene, controles y evolución biológica.</p>',
      '<p>El paciente declara haber podido plantear preguntas, haber recibido respuestas comprensibles y saber que puede revocar este consentimiento antes del procedimiento.</p>',
      '<p>Firma del paciente o representante legal y del profesional:</p>',
    ].join('\n'),
  },
  {
    catalog_key: 'cc_base_imagen_clinica_v1',
    name: 'Autorización de fotografías clínicas',
    description: 'Autorización separada para imágenes clínicas de seguimiento. No cubre publicidad ni redes sociales.',
    purpose: 'clinical_image',
    blocking_policy: 'soft',
    validity_mode: 'treatment_episode',
    is_generic: true,
    disciplines: ['dental', 'estetica', 'capilar'],
    requires_professional_signature: false,
    title: 'Autorización de fotografías clínicas',
    body_html: [
      '<h2>Autorización de fotografías clínicas</h2>',
      '<p><strong>Paciente:</strong> {{paciente.nombre_completo}} · <strong>Documento:</strong> {{paciente.documento}}</p>',
      '<p><strong>Clínica:</strong> {{clinica.nombre}}</p>',
      '<p>El paciente autoriza la toma y conservación de fotografías, vídeos o registros visuales estrictamente necesarios para documentar su estado clínico, planificar el tratamiento, comparar evolución y completar su historia clínica.</p>',
      '<p>Estas imágenes se incorporarán a la historia clínica y se usarán únicamente por el equipo asistencial autorizado. Esta autorización no permite el uso de imágenes en web, redes sociales, publicidad, casos de éxito, docencia externa ni comunicaciones comerciales.</p>',
      '<p>El uso publicitario, docente o comercial de imágenes requiere un consentimiento independiente, opcional y revocable.</p>',
      '<p>Firma del paciente o representante legal:</p>',
    ].join('\n'),
  },
];

function publicId() {
  return `cadmin_${crypto.randomBytes(10).toString('hex')}`;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();

    for (const item of templates) {
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

      if (!catalogId) continue;

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
        variable_schema: JSON.stringify(variableSchema),
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
