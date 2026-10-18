'use strict';

// Data-only preparation. No scope copies, historical replay, activation,
// delivery flags, jobs, messages, credentials or Meta submission.
const C = require('../src/lib/patient-mobile-verification');
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      const ensure = async (table, whereSql, replacements, row) => {
        const [existing] = await queryInterface.sequelize.query(`SELECT id FROM ${table} WHERE ${whereSql} LIMIT 1`, { replacements, transaction });
        if (!existing.length) await queryInterface.bulkInsert(table, [row], { transaction });
      };
      const now = new Date(), definition = C.definition();
      await ensure('AutomationFlowTemplatesV2', 'template_key=:key AND version=1', { key: C.FAMILY }, {
        ...definition, nodes: JSON.stringify(definition.nodes), trigger_config: JSON.stringify(definition.trigger_config),
        created_at: now, updated_at: now,
      });
      await ensure('AutomationFlowCatalog', 'name=:name', { name: C.FAMILY }, {
        name: C.FAMILY, display_name: 'Verificación de cambio de móvil', description: definition.description,
        trigger_type: C.REQUEST, steps: JSON.stringify([]), template_key: C.FAMILY, template_version: 1,
        is_generic: true, is_active: false, is_default_for_trigger: false, created_at: now, updated_at: now,
      });
      await ensure('WhatsappTemplateCatalog', 'name=:name', { name: C.TEMPLATE }, {
        name: C.TEMPLATE, family_key: C.TEMPLATE, locale: 'es', display_name: 'Verificar cambio de móvil',
        category: 'UTILITY', body_text: C.BODY,
        variables: JSON.stringify([{ position: 1, name: 'nombre_clinica', example: 'Clínica de prueba', description: 'Nombre de la clínica' }]),
        components: JSON.stringify([{ type: 'BODY', text: C.BODY, example: { body_text: [['Clínica de prueba']] } },
          { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }]),
        is_generic: false, is_active: false, propagation_state: 'prepared', created_at: now, updated_at: now,
      });
    });
  },
  async down() {
    throw new Error('Preserve the verification catalogue and audit evidence; disable by controlled publication, not destructive rollback.');
  },
};
