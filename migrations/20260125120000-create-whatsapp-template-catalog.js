'use strict';

/**
 * Migration: Catálogo de plantillas de WhatsApp y disciplinas asociadas.
 * También extiende WhatsappTemplates con campos de catálogo y estado.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1) Catálogo maestro
    await queryInterface.createTable('WhatsappTemplateCatalog', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(100), allowNull: false, unique: true },
      display_name: { type: Sequelize.STRING(150), allowNull: true },
      category: { type: Sequelize.ENUM('UTILITY', 'MARKETING'), allowNull: false },
      body_text: { type: Sequelize.TEXT, allowNull: false },
      variables: { type: Sequelize.JSON, allowNull: true },
      components: { type: Sequelize.JSON, allowNull: true },
      is_generic: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // 2) Asociación catálogo ↔ disciplina (disciplina_code = string, ej: 'dental')
    await queryInterface.createTable('WhatsappTemplateCatalogDisciplines', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      template_catalog_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'WhatsappTemplateCatalog', key: 'id' },
        onDelete: 'CASCADE',
      },
      disciplina_code: { type: Sequelize.STRING(50), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addConstraint('WhatsappTemplateCatalogDisciplines', {
      fields: ['template_catalog_id', 'disciplina_code'],
      type: 'unique',
      name: 'uniq_catalog_disciplina',
    });

    // 3) Extender WhatsappTemplates existente
    await queryInterface.addColumn('WhatsappTemplates', 'catalog_template_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'WhatsappTemplateCatalog', key: 'id' },
      onDelete: 'SET NULL',
    });

    await queryInterface.addColumn('WhatsappTemplates', 'origin', {
      type: Sequelize.ENUM('catalog', 'custom', 'external'),
      allowNull: false,
      defaultValue: 'catalog',
    });

    await queryInterface.addColumn('WhatsappTemplates', 'rejection_reason', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addColumn('WhatsappTemplates', 'is_active', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('WhatsappTemplates', 'is_active');
    await queryInterface.removeColumn('WhatsappTemplates', 'rejection_reason');
    await queryInterface.removeColumn('WhatsappTemplates', 'origin');
    await queryInterface.removeColumn('WhatsappTemplates', 'catalog_template_id');

    await queryInterface.dropTable('WhatsappTemplateCatalogDisciplines');
    await queryInterface.dropTable('WhatsappTemplateCatalog');

    // Drop enums if needed
    if (queryInterface.sequelize.getDialect() === 'mysql') {
      // MySQL drops enum automatically with column removal
    } else if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_WhatsappTemplateCatalog_category";');
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_WhatsappTemplates_origin";');
    }
  },
};
