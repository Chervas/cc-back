'use strict';

// Deliberadamente posterior a la migración de idioma preferido del paciente.

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('WhatsappTemplateCatalog');

    if (!table.family_key) {
      await queryInterface.addColumn('WhatsappTemplateCatalog', 'family_key', {
        type: Sequelize.STRING(100),
        allowNull: true,
        after: 'name',
      });
    }
    if (!table.locale) {
      await queryInterface.addColumn('WhatsappTemplateCatalog', 'locale', {
        type: Sequelize.STRING(5),
        allowNull: false,
        defaultValue: 'es',
        after: 'family_key',
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE WhatsappTemplateCatalog
      SET family_key = name
      WHERE family_key IS NULL OR TRIM(family_key) = ''
    `);

    await queryInterface.changeColumn('WhatsappTemplateCatalog', 'family_key', {
      type: Sequelize.STRING(100),
      allowNull: false,
    });

    const indexes = await queryInterface.showIndex('WhatsappTemplateCatalog');
    if (!indexes.some((index) => index.name === 'uniq_whatsapp_template_catalog_family_locale')) {
      await queryInterface.addIndex('WhatsappTemplateCatalog', ['family_key', 'locale'], {
        unique: true,
        name: 'uniq_whatsapp_template_catalog_family_locale',
      });
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('WhatsappTemplateCatalog');
    if (indexes.some((index) => index.name === 'uniq_whatsapp_template_catalog_family_locale')) {
      await queryInterface.removeIndex('WhatsappTemplateCatalog', 'uniq_whatsapp_template_catalog_family_locale');
    }
    const table = await queryInterface.describeTable('WhatsappTemplateCatalog');
    if (table.locale) await queryInterface.removeColumn('WhatsappTemplateCatalog', 'locale');
    if (table.family_key) await queryInterface.removeColumn('WhatsappTemplateCatalog', 'family_key');
  },
};
