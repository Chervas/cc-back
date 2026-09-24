'use strict';

const crypto = require('crypto');

const CATALOG_PUBLIC_ID = 'etc_clinic_news_test_v1';
const CATALOG_KEY = 'clinic_news_test';
const DESIGN = {
  header_color: '#0f766e',
  footer_color: '#0f172a',
  background_color: '#f1f5f9',
  content_color: '#ffffff',
  text_color: '#1e293b',
  logo_url: null,
  blocks: [
    { type: 'heading', text: 'Hola {{nombre}}' },
    { type: 'text', text: 'Queremos compartir contigo una novedad de {{clinica}}.' },
    { type: 'button', text: 'Más información', url: 'https://clinicaclick.com' },
  ],
};

function renderedHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Novedades de {{clinica}}</title></head><body style="margin:0;background:#f1f5f9"><div style="display:none;max-height:0;overflow:hidden;opacity:0">Información de tu clínica</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-collapse:collapse"><tr><td style="padding:20px 28px;background:#0f766e"><span style="font:700 18px Arial,sans-serif;color:#ffffff">{{clinica}}</span></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 18px;font:700 26px/1.25 Arial,sans-serif;color:#1e293b">Hola {{nombre}}</h1><p style="margin:0 0 18px;font:15px/1.65 Arial,sans-serif;color:#1e293b">Queremos compartir contigo una novedad de {{clinica}}.</p><p style="margin:0 0 20px"><a href="https://clinicaclick.com" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#0f766e;color:#ffffff;text-decoration:none;font:700 14px Arial,sans-serif">Más información</a></p></td></tr><tr><td style="padding:16px 24px;background:#0f172a;text-align:center;color:#cbd5e1;font:12px/1.5 Arial,sans-serif">{{clinica}}</td></tr></table></td></tr></table></body></html>';
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const timestamps = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    };

    const tableNames = (await queryInterface.showAllTables()).map(table => (
      typeof table === 'string' ? table : table.tableName || table.name
    ));
    if (!tableNames.includes('MarketingEmailTemplateCatalog')) {
      await queryInterface.createTable('MarketingEmailTemplateCatalog', {
        id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        public_id: { type: Sequelize.STRING(64), allowNull: false, unique: true },
        catalog_key: { type: Sequelize.STRING(100), allowNull: false, unique: true },
        name: { type: Sequelize.STRING(160), allowNull: false },
        status: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'ready' },
        subject: { type: Sequelize.STRING(160), allowNull: false },
        preheader: { type: Sequelize.STRING(255), allowNull: true },
        layout_key: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'classic' },
        design: { type: Sequelize.JSON, allowNull: false },
        rendered_html: { type: Sequelize.TEXT('long'), allowNull: true },
        rendered_text: { type: Sequelize.TEXT('long'), allowNull: true },
        version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        propagation_state: { type: Sequelize.STRING(24), allowNull: true },
        last_propagated_at: { type: Sequelize.DATE, allowNull: true },
        created_by: { type: Sequelize.INTEGER, allowNull: true },
        updated_by: { type: Sequelize.INTEGER, allowNull: true },
        ...timestamps,
      });
    }

    const templateColumns = await queryInterface.describeTable('MarketingEmailTemplates');
    if (!templateColumns.catalog_template_id) {
      await queryInterface.addColumn('MarketingEmailTemplates', 'catalog_template_id', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'MarketingEmailTemplateCatalog', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }
    if (!templateColumns.catalog_version) {
      await queryInterface.addColumn('MarketingEmailTemplates', 'catalog_version', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
      });
    }
    if (!templateColumns.origin) {
      await queryInterface.addColumn('MarketingEmailTemplates', 'origin', {
        type: Sequelize.STRING(24),
        allowNull: false,
        defaultValue: 'custom',
      });
    }
    const templateIndexes = await queryInterface.showIndex('MarketingEmailTemplates');
    if (!templateIndexes.some(index => index.name === 'uq_marketing_email_system_template_scope')) {
      await queryInterface.addIndex('MarketingEmailTemplates', ['scope_key', 'catalog_template_id'], {
        name: 'uq_marketing_email_system_template_scope',
        unique: true,
      });
    }

    const now = new Date();
    let [catalog] = await queryInterface.sequelize.query(
      'SELECT id FROM MarketingEmailTemplateCatalog WHERE public_id = :publicId LIMIT 1',
      { replacements: { publicId: CATALOG_PUBLIC_ID }, type: Sequelize.QueryTypes.SELECT }
    );
    if (!catalog) {
      await queryInterface.bulkInsert('MarketingEmailTemplateCatalog', [{
        public_id: CATALOG_PUBLIC_ID,
        catalog_key: CATALOG_KEY,
        name: 'Novedades de la clínica · Prueba',
        status: 'ready',
        subject: 'Novedades de {{clinica}}',
        preheader: 'Información de tu clínica',
        layout_key: 'classic',
        design: JSON.stringify(DESIGN),
        rendered_html: renderedHtml(),
        rendered_text: 'Hola {{nombre}}\n\nQueremos compartir contigo una novedad de {{clinica}}.\n\nMás información',
        version: 1,
        is_active: true,
        propagation_state: 'complete',
        last_propagated_at: now,
        created_at: now,
        updated_at: now,
      }]);
      [catalog] = await queryInterface.sequelize.query(
        'SELECT id FROM MarketingEmailTemplateCatalog WHERE public_id = :publicId LIMIT 1',
        { replacements: { publicId: CATALOG_PUBLIC_ID }, type: Sequelize.QueryTypes.SELECT }
      );
    }
    const clinics = await queryInterface.sequelize.query(
      'SELECT id_clinica FROM Clinicas',
      { type: Sequelize.QueryTypes.SELECT }
    );
    const groups = await queryInterface.sequelize.query(
      'SELECT id_grupo FROM GruposClinicas',
      { type: Sequelize.QueryTypes.SELECT }
    );
    const scopes = [
      ...clinics.map(row => ({ scope_type: 'clinic', scope_key: `clinic:${row.id_clinica}`, clinica_id: row.id_clinica, grupo_clinica_id: null })),
      ...groups.map(row => ({ scope_type: 'group', scope_key: `group:${row.id_grupo}`, clinica_id: null, grupo_clinica_id: row.id_grupo })),
    ];
    const linkedInstances = catalog?.id ? await queryInterface.sequelize.query(
      'SELECT scope_key FROM MarketingEmailTemplates WHERE catalog_template_id = :catalogId',
      { replacements: { catalogId: catalog.id }, type: Sequelize.QueryTypes.SELECT }
    ) : [];
    const linkedScopes = new Set(linkedInstances.map(row => row.scope_key));
    const missingScopes = scopes.filter(scope => !linkedScopes.has(scope.scope_key));
    if (catalog?.id && missingScopes.length) {
      await queryInterface.bulkInsert('MarketingEmailTemplates', missingScopes.map(scope => ({
        public_id: `et_${crypto.randomUUID()}`,
        ...scope,
        name: 'Novedades de la clínica · Prueba',
        status: 'ready',
        subject: 'Novedades de {{clinica}}',
        preheader: 'Información de tu clínica',
        layout_key: 'classic',
        design: JSON.stringify(DESIGN),
        rendered_html: renderedHtml(),
        rendered_text: 'Hola {{nombre}}\n\nQueremos compartir contigo una novedad de {{clinica}}.\n\nMás información',
        version: 1,
        catalog_template_id: catalog.id,
        catalog_version: 1,
        origin: 'system',
        created_at: now,
        updated_at: now,
      })));
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('MarketingEmailTemplates', 'uq_marketing_email_system_template_scope');
    await queryInterface.removeColumn('MarketingEmailTemplates', 'origin');
    await queryInterface.removeColumn('MarketingEmailTemplates', 'catalog_version');
    await queryInterface.removeColumn('MarketingEmailTemplates', 'catalog_template_id');
    await queryInterface.dropTable('MarketingEmailTemplateCatalog');
  },
};
