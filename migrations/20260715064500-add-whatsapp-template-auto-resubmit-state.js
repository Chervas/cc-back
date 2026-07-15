'use strict';

const TABLE = 'WhatsappTemplates';
const INDEX = 'idx_whatsapp_templates_pending_auto_resubmit';
const MANUAL_RESUBMIT_META_TEMPLATE_ID = '986959627638045';
const MANUAL_RESUBMIT_TEMPLATE_NAME =
  'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v11';

async function hasIndex(queryInterface) {
  const indexes = await queryInterface.showIndex(TABLE);
  return indexes.some((index) => index.name === INDEX);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = await queryInterface.describeTable(TABLE);

    if (!definition.pending_since_at) {
      await queryInterface.addColumn(TABLE, 'pending_since_at', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Inicio estable del estado pendiente usado por el reintento automatico',
      });
    }
    if (!definition.auto_resubmit_attempt_count) {
      await queryInterface.addColumn(TABLE, 'auto_resubmit_attempt_count', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Numero de reenvios automaticos ya consumidos para esta plantilla',
      });
    }
    if (!definition.auto_resubmit_attempted_at) {
      await queryInterface.addColumn(TABLE, 'auto_resubmit_attempted_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
    if (!definition.resubmitted_from_template_id) {
      await queryInterface.addColumn(TABLE, 'resubmitted_from_template_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }
    if (!definition.superseded_by_template_id) {
      await queryInterface.addColumn(TABLE, 'superseded_by_template_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }
    if (!definition.auto_resubmit_error) {
      await queryInterface.addColumn(TABLE, 'auto_resubmit_error', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }

    if (!(await hasIndex(queryInterface))) {
      await queryInterface.addIndex(
        TABLE,
        ['waba_id', 'status', 'is_active', 'auto_resubmit_attempt_count', 'pending_since_at'],
        { name: INDEX }
      );
    }

    // Existing pending WABA templates have no reliable transition timestamp.
    // Prefer the latest known Meta sync so the first automatic retry cannot be
    // triggered prematurely; createdAt is the conservative fallback.
    await queryInterface.sequelize.query(`
      UPDATE \`${TABLE}\`
      SET \`pending_since_at\` = COALESCE(\`last_synced_at\`, \`createdAt\`)
      WHERE \`pending_since_at\` IS NULL
        AND \`waba_id\` IS NOT NULL
        AND \`is_active\` = 1
        AND UPPER(\`status\`) IN ('PENDING', 'IN_REVIEW')
    `);

    // This replacement was submitted manually before automatic retry state
    // existed. Mark its one allowed attempt as consumed even if Meta has
    // already approved it, so it can never seed a retry loop later.
    await queryInterface.sequelize.query(
      `
        UPDATE \`${TABLE}\`
        SET \`auto_resubmit_attempt_count\` = CASE
          WHEN \`auto_resubmit_attempt_count\` < 1 THEN 1
          ELSE \`auto_resubmit_attempt_count\`
        END
        WHERE \`meta_template_id\` = :metaTemplateId
           OR \`name\` = :templateName
      `,
      {
        replacements: {
          metaTemplateId: MANUAL_RESUBMIT_META_TEMPLATE_ID,
          templateName: MANUAL_RESUBMIT_TEMPLATE_NAME,
        },
      }
    );
  },

  async down(queryInterface) {
    if (await hasIndex(queryInterface)) {
      await queryInterface.removeIndex(TABLE, INDEX);
    }

    const definition = await queryInterface.describeTable(TABLE);
    const columns = [
      'auto_resubmit_error',
      'superseded_by_template_id',
      'resubmitted_from_template_id',
      'auto_resubmit_attempted_at',
      'auto_resubmit_attempt_count',
      'pending_since_at',
    ];

    for (const column of columns) {
      if (definition[column]) {
        await queryInterface.removeColumn(TABLE, column);
      }
    }
  },
};
