'use strict';

const NAMES = ['clinicaclick_solicitar_resena', 'clinicaclick_solicitar_resena_foto'];
const BODY = [
  '\u00a1Hola {{1}}! Soy {{3}} de {{2}}.',
  '',
  '\u00bfTe puedo hacer una pregunta? Como viste, en la cl\u00ednica somos una peque\u00f1a familia, y saber c\u00f3mo te atendimos en tu visita del {{4}} y en general en la cl\u00ednica, es importante para nosotros. \u00bfC\u00f3mo valorar\u00edas tu experiencia?',
  '',
  'Responde con un n\u00famero:',
  '',
  '5 \u2b50\u2b50\u2b50\u2b50\u2b50',
  '4 \u2b50\u2b50\u2b50\u2b50',
  '3 \u2b50\u2b50\u2b50',
  '2 \u2b50\u2b50',
  '1 \u2b50',
  '',
  'Tu valoraci\u00f3n nos ayuda mucho',
  '',
  '\u2014',
].join('\n');
const VARIABLES = [
  ['nombre_paciente', 'Inmaculada', 'Nombre del paciente'],
  ['nombre_clinica', 'Cl\u00ednica Dental Centro', 'Nombre visible de la cl\u00ednica'],
  ['firma_resenas', 'Recepci\u00f3n', 'Remitente de la rese\u00f1a'],
  ['fecha_ultima_cita_asistida', '21/05/2026', 'Fecha de la \u00faltima cita asistida'],
].map(([name, example, description], index) => ({ position: index + 1, name, example, description,
  template_usage: 'solicitud_resena' }));

function componentsFor(row) {
  const components = typeof row.components === 'string' ? JSON.parse(row.components) : row.components || [];
  const header = components.find(item => String(item?.type).toUpperCase() === 'HEADER');
  if (row.name === NAMES[1] && String(header?.format).toUpperCase() !== 'IMAGE') {
    throw new Error('review_photo_catalog_header_missing');
  }
  return [...(row.name === NAMES[1] ? [header] : []), { type: 'BODY', text: BODY,
    example: { body_text: [VARIABLES.map(item => item.example)] } }];
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id,name,components FROM WhatsappTemplateCatalog WHERE name IN (:names) FOR UPDATE',
        { replacements: { names: NAMES }, transaction });
      if (rows.length !== 2) throw new Error('review_system_catalog_incomplete');
      for (const row of rows) {
        await queryInterface.sequelize.query(`UPDATE WhatsappTemplateCatalog SET category='UTILITY',
          body_text=:body,variables=:variables,components=:components,propagation_state=NULL,updated_at=NOW()
          WHERE id=:id`, { transaction, replacements: { id: row.id, body: BODY,
          variables: JSON.stringify(VARIABLES), components: JSON.stringify(componentsFor(row)) } });
      }
    });
  },
  async down() {
    throw new Error('review_catalog_restore_requires_verified_backup_and_native_propagation');
  },
  _test: { NAMES, BODY, VARIABLES, componentsFor },
};
