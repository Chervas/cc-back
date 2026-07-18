'use strict';

const TABLE = 'WebArtifacts';

function tableNameOf(value) {
  return typeof value === 'string' ? value : value?.tableName || value?.table_name || null;
}

async function exists(queryInterface) {
  return (await queryInterface.showAllTables()).some((value) => tableNameOf(value) === TABLE);
}

async function assertCompatible(queryInterface) {
  const description = await queryInterface.describeTable(TABLE);
  const required = [
    'id', 'project_id', 'revision_id', 'renderer_version', 'environment', 'base_url',
    'base_url_hash', 'artifact_hash', 'document_hash', 'content_snapshot_hash',
    'runtime_config_hash', 'manifest', 'files', 'qa_report', 'status', 'created_by_user_id', 'created_at',
  ];
  const missing = required.filter((column) => !Object.hasOwn(description, column));
  if (missing.length) {
    const error = new Error(`${TABLE} existe pero no coincide con el contrato: faltan ${missing.join(', ')}`);
    error.code = 'web_artifact_migration_incompatible_table';
    error.details = { table: TABLE, missing_columns: missing };
    throw error;
  }
}

async function addIndex(queryInterface, fields, options) {
  const indexes = await queryInterface.showIndex(TABLE);
  const existing = indexes.find((index) => index.name === options.name);
  if (existing) {
    const actualFields = (existing.fields || []).map((field) => field.attribute || field.name).join(',');
    if (actualFields !== fields.join(',') || Boolean(existing.unique) !== Boolean(options.unique)) {
      const error = new Error(`${TABLE}.${options.name} existe con un contrato incompatible`);
      error.code = 'web_artifact_migration_incompatible_index';
      throw error;
    }
    return;
  }
  await queryInterface.addIndex(TABLE, fields, options);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await exists(queryInterface))) {
      await queryInterface.createTable(TABLE, {
        id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
        project_id: {
          type: Sequelize.STRING(36),
          allowNull: false,
          references: { model: 'WebProjects', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        revision_id: {
          type: Sequelize.STRING(36),
          allowNull: false,
          references: { model: 'WebRevisions', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        renderer_version: { type: Sequelize.STRING(64), allowNull: false },
        environment: {
          type: Sequelize.ENUM('preview', 'production'),
          allowNull: false,
          defaultValue: 'preview',
        },
        base_url: { type: Sequelize.TEXT, allowNull: false },
        base_url_hash: { type: Sequelize.STRING(64), allowNull: false },
        runtime_config_hash: { type: Sequelize.STRING(64), allowNull: false },
        artifact_hash: { type: Sequelize.STRING(64), allowNull: false },
        document_hash: { type: Sequelize.STRING(64), allowNull: false },
        content_snapshot_hash: { type: Sequelize.STRING(64), allowNull: false },
        manifest: { type: Sequelize.JSON, allowNull: false },
        files: { type: Sequelize.JSON, allowNull: false },
        qa_report: { type: Sequelize.JSON, allowNull: false },
        status: {
          type: Sequelize.ENUM('ready', 'failed', 'retired'),
          allowNull: false,
          defaultValue: 'ready',
        },
        created_by_user_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    } else {
      await assertCompatible(queryInterface);
    }

    await addIndex(queryInterface, ['artifact_hash'], {
      name: 'uniq_web_artifacts_hash',
      unique: true,
    });
    await addIndex(queryInterface, ['revision_id', 'renderer_version', 'environment', 'base_url_hash', 'runtime_config_hash'], {
      name: 'uniq_web_artifacts_revision_renderer_target',
      unique: true,
    });
    await addIndex(queryInterface, ['project_id', 'created_at'], {
      name: 'idx_web_artifacts_project_created',
    });
    await addIndex(queryInterface, ['status', 'created_at'], {
      name: 'idx_web_artifacts_status_created',
    });
  },

  async down(queryInterface) {
    if (await exists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
