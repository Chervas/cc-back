'use strict';

function tableNameOf(table) {
  return typeof table === 'string'
    ? table
    : (table?.tableName || table?.table_name || table?.name || '');
}

async function hasTable(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables.some((table) => tableNameOf(table).toLowerCase() === tableName.toLowerCase());
}

async function addColumnIfMissing(queryInterface, tableName, columnName, definition) {
  if (!await hasTable(queryInterface, tableName)) return;
  const columns = await queryInterface.describeTable(tableName);
  if (!columns[columnName]) {
    await queryInterface.addColumn(tableName, columnName, definition);
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!await hasTable(queryInterface, 'WhatsappDeliverySnapshots')) {
      await queryInterface.createTable('WhatsappDeliverySnapshots', {
        id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
        route_key: { type: Sequelize.STRING(64), allowNull: false, unique: true },
        business_portfolio_id: { type: Sequelize.STRING(255), allowNull: true },
        waba_id: { type: Sequelize.STRING(255), allowNull: true },
        phone_number_id: { type: Sequelize.STRING(255), allowNull: true },
        meta_template_id: { type: Sequelize.STRING(255), allowNull: true },
        template_name: { type: Sequelize.STRING(255), allowNull: true },
        template_language: { type: Sequelize.STRING(32), allowNull: true },
        account_quality: { type: Sequelize.STRING(32), allowNull: true },
        template_quality: { type: Sequelize.STRING(32), allowNull: true },
        template_status: { type: Sequelize.STRING(64), allowNull: true },
        capacity_limit: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
        estimated_unique_24h: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
        immediate_status: { type: Sequelize.STRING(64), allowNull: true },
        hold_started_at: { type: Sequelize.DATE, allowNull: true },
        hold_released_at: { type: Sequelize.DATE, allowNull: true },
        next_check_at: { type: Sequelize.DATE, allowNull: true },
        check_attempt: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        can_send: { type: Sequelize.BOOLEAN, allowNull: true },
        source: { type: Sequelize.STRING(96), allowNull: false, defaultValue: 'local' },
        payload: { type: Sequelize.JSON, allowNull: true },
        provider_event_at: { type: Sequelize.DATE, allowNull: true },
        checked_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('WhatsappDeliverySnapshots', ['business_portfolio_id', 'updated_at'], { name: 'idx_wa_delivery_snapshot_portfolio' });
      await queryInterface.addIndex('WhatsappDeliverySnapshots', ['waba_id', 'phone_number_id'], { name: 'idx_wa_delivery_snapshot_waba_phone' });
      await queryInterface.addIndex('WhatsappDeliverySnapshots', ['meta_template_id', 'template_language'], { name: 'idx_wa_delivery_snapshot_template' });
      await queryInterface.addIndex('WhatsappDeliverySnapshots', ['immediate_status', 'next_check_at'], { name: 'idx_wa_delivery_snapshot_hold_check' });
    }

    if (!await hasTable(queryInterface, 'WhatsappDeliveryEvents')) {
      await queryInterface.createTable('WhatsappDeliveryEvents', {
        id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
        dedupe_key: { type: Sequelize.STRING(64), allowNull: false, unique: true },
        event_type: { type: Sequelize.STRING(96), allowNull: false },
        source: { type: Sequelize.STRING(96), allowNull: false },
        severity: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'info' },
        business_portfolio_id: { type: Sequelize.STRING(255), allowNull: true },
        waba_id: { type: Sequelize.STRING(255), allowNull: true },
        phone_number_id: { type: Sequelize.STRING(255), allowNull: true },
        meta_template_id: { type: Sequelize.STRING(255), allowNull: true },
        template_name: { type: Sequelize.STRING(255), allowNull: true },
        template_language: { type: Sequelize.STRING(32), allowNull: true },
        list_id: { type: Sequelize.INTEGER, allowNull: true },
        item_id: { type: Sequelize.INTEGER, allowNull: true },
        message_id: { type: Sequelize.INTEGER, allowNull: true },
        reason_code: { type: Sequelize.STRING(96), allowNull: true },
        status: { type: Sequelize.STRING(64), allowNull: true },
        payload: { type: Sequelize.JSON, allowNull: true },
        occurred_at: { type: Sequelize.DATE, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('WhatsappDeliveryEvents', ['waba_id', 'occurred_at'], { name: 'idx_wa_delivery_event_waba_date' });
      await queryInterface.addIndex('WhatsappDeliveryEvents', ['meta_template_id', 'occurred_at'], { name: 'idx_wa_delivery_event_template_date' });
      await queryInterface.addIndex('WhatsappDeliveryEvents', ['list_id', 'occurred_at'], { name: 'idx_wa_delivery_event_list_date' });
    }

    await addColumnIfMissing(queryInterface, 'WhatsappTemplates', 'quality_score', { type: Sequelize.STRING(32), allowNull: true });
    await addColumnIfMissing(queryInterface, 'WhatsappTemplates', 'previous_quality_score', { type: Sequelize.STRING(32), allowNull: true });
    await addColumnIfMissing(queryInterface, 'WhatsappTemplates', 'quality_updated_at', { type: Sequelize.DATE, allowNull: true });
    await addColumnIfMissing(queryInterface, 'WhatsappTemplates', 'provider_status_updated_at', { type: Sequelize.DATE, allowNull: true });
    await addColumnIfMissing(queryInterface, 'WhatsappTemplates', 'pause_count', { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
    await addColumnIfMissing(queryInterface, 'WhatsappTemplates', 'last_paused_at', { type: Sequelize.DATE, allowNull: true });
    await addColumnIfMissing(queryInterface, 'WhatsappTemplates', 'last_unpaused_at', { type: Sequelize.DATE, allowNull: true });

    if (await hasTable(queryInterface, 'MarketingPatientLists')) {
      const [legacyRows] = await queryInterface.sequelize.query(`
        SELECT id, criteria
        FROM MarketingPatientLists
        WHERE objective_id = 'mass_sends'
          AND status = 'paused'
          AND JSON_UNQUOTE(JSON_EXTRACT(criteria, '$.dispatch.status')) = 'paused_limit'
          AND JSON_UNQUOTE(JSON_EXTRACT(criteria, '$.dispatch.paused_reason')) = 'messaging_limit_reached'
          AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(counters, '$.sent')) AS UNSIGNED), 0) >= 1000
      `);

      for (const row of legacyRows) {
        const criteria = typeof row.criteria === 'string' ? JSON.parse(row.criteria || '{}') : (row.criteria || {});
        const dispatch = criteria.dispatch || {};
        criteria.dispatch = {
          ...dispatch,
          status: 'paused_review',
          paused_reason: 'legacy_messaging_limit_review',
          paused_at: dispatch.paused_at || new Date().toISOString(),
          next_allowed_at: null,
          requires_admin_review: true,
          resume_automatically: false,
          status_message: 'La cola permanece detenida hasta que un administrador revise el límite anterior.',
        };
        await queryInterface.sequelize.query(
          'UPDATE MarketingPatientLists SET status = :status, criteria = :criteria, updated_at = CURRENT_TIMESTAMP WHERE id = :id',
          { replacements: { id: row.id, status: 'paused', criteria: JSON.stringify(criteria) } },
        );
        if (await hasTable(queryInterface, 'JobRequests')) {
          await queryInterface.sequelize.query(`
            UPDATE JobRequests
            SET status = 'cancelled', error_message = 'legacy_messaging_limit_review', updated_at = CURRENT_TIMESTAMP
            WHERE type = 'marketing_bulk_send_dispatch'
              AND status IN ('pending', 'queued', 'waiting')
              AND CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.list_id')) AS UNSIGNED) = :listId
          `, { replacements: { listId: row.id } });
        }
      }
    }
  },

  async down(queryInterface) {
    if (await hasTable(queryInterface, 'WhatsappTemplates')) {
      const columns = await queryInterface.describeTable('WhatsappTemplates');
      for (const column of [
        'quality_score',
        'previous_quality_score',
        'quality_updated_at',
        'provider_status_updated_at',
        'pause_count',
        'last_paused_at',
        'last_unpaused_at',
      ]) {
        if (columns[column]) await queryInterface.removeColumn('WhatsappTemplates', column);
      }
    }
    if (await hasTable(queryInterface, 'WhatsappDeliveryEvents')) {
      await queryInterface.dropTable('WhatsappDeliveryEvents');
    }
    if (await hasTable(queryInterface, 'WhatsappDeliverySnapshots')) {
      await queryInterface.dropTable('WhatsappDeliverySnapshots');
    }
  },
};
