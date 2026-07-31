'use strict';

const TEMPLATE_NAME = 'clinicaclick_envio_presupuesto_firma';
const FAMILY_KEY = 'budget_signature_request';
const BODY_TEXT = 'Hola {{1}}, te enviamos tu presupuesto {{2}} de {{3}}. Puedes revisarlo y firmarlo aquí: {{4}}\n\nSi falta algún dato de pago, lo completaremos contigo en la clínica.';

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const variables = JSON.stringify([
      { position: 1, name: 'paciente' },
      { position: 2, name: 'presupuesto' },
      { position: 3, name: 'clinica' },
      { position: 4, name: 'enlace_firma' },
    ]);
    const components = JSON.stringify([{
      type: 'BODY',
      text: BODY_TEXT,
      example: {
        body_text: [[
          'María',
          'PRES-2026-0001',
          'Clínica Centro',
          'https://tablet.clinicaclick.com/presupuestos/firmar/...',
        ]],
      },
    }]);
    const existing = await queryInterface.sequelize.query(
      'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
      { replacements: { name: TEMPLATE_NAME }, type: Sequelize.QueryTypes.SELECT },
    );
    if (existing.length) {
      await queryInterface.bulkUpdate('WhatsappTemplateCatalog', {
        family_key: FAMILY_KEY,
        locale: 'es',
        display_name: 'Envío de presupuesto para firma',
        category: 'UTILITY',
        body_text: BODY_TEXT,
        variables,
        components,
        is_generic: true,
        is_active: true,
        updated_at: now,
      }, { id: existing[0].id });
      return;
    }
    await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
      name: TEMPLATE_NAME,
      family_key: FAMILY_KEY,
      locale: 'es',
      display_name: 'Envío de presupuesto para firma',
      category: 'UTILITY',
      body_text: BODY_TEXT,
      variables,
      components,
      is_generic: true,
      is_active: true,
      created_at: now,
      updated_at: now,
    }]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('WhatsappTemplateCatalog', { name: TEMPLATE_NAME });
  },
};
