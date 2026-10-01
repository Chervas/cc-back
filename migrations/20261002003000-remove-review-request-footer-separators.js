'use strict';

const NAMES = ['clinicaclick_solicitar_resena', 'clinicaclick_solicitar_resena_foto'];
function withoutTrailingSeparators(text) {
  return String(text || '').replace(/(?:\r?\n[\t ]*)+(?:[-\u2013\u2014]+[\t ]*(?:\r?\n[\t ]*)?)+$/, '').trimEnd();
}
function componentsWithoutSeparators(value) {
  const components = typeof value === 'string' ? JSON.parse(value) : value || [];
  return components.filter(component => !(String(component.type).toUpperCase() === 'FOOTER'
    && /^[-\u2013\u2014\s]+$/.test(component.text || ''))).map(component =>
    String(component.type).toUpperCase() === 'BODY'
      ? { ...component, text: withoutTrailingSeparators(component.text) } : component);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id,name,body_text,components FROM WhatsappTemplateCatalog WHERE name IN (:names) FOR UPDATE',
        { replacements: { names: NAMES }, transaction });
      if (rows.length !== 2) throw Error('review_system_catalog_incomplete');
      for (const row of rows) {
        const body = withoutTrailingSeparators(row.body_text);
        const components = componentsWithoutSeparators(row.components);
        if (body === row.body_text && JSON.stringify(components) === JSON.stringify(typeof row.components === 'string' ? JSON.parse(row.components) : row.components)) continue;
        await queryInterface.sequelize.query(`UPDATE WhatsappTemplateCatalog SET body_text=:body,
          components=:components,propagation_state=NULL,updated_at=NOW() WHERE id=:id`,
        { transaction, replacements: { id: row.id, body, components: JSON.stringify(components) } });
      }
    });
  },
  async down() { throw Error('review_catalog_restore_requires_verified_backup_and_native_propagation'); },
  _test: { NAMES, withoutTrailingSeparators, componentsWithoutSeparators },
};
