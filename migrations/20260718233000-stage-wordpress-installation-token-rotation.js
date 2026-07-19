'use strict';

const TABLE = 'WebWordpressInstallations';
const INDEX = 'uniq_web_wordpress_next_token_hash';

function migrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

async function hasColumn(queryInterface, column) {
  const table = await queryInterface.describeTable(TABLE);
  return Boolean(table[column]);
}

async function indexes(queryInterface) {
  if (typeof queryInterface.showIndex !== 'function') {
    throw migrationError(
      'web_wordpress_token_rotation_introspection_unavailable',
      'No se pueden inspeccionar de forma segura los índices de WebWordpressInstallations.'
    );
  }
  return queryInterface.showIndex(TABLE);
}

function indexFields(index) {
  return (Array.isArray(index?.fields) ? index.fields : [])
    .map((field) => String(field?.attribute || field?.name || field || ''));
}

function assertCompatibleIndex(rows) {
  const index = rows.find((candidate) => String(candidate?.name || '') === INDEX);
  if (!index) return false;
  const actualFields = indexFields(index);
  if (!index.unique || JSON.stringify(actualFields) !== JSON.stringify(['next_token_hash'])) {
    throw migrationError(
      'web_wordpress_token_rotation_index_incompatible',
      `El índice ${INDEX} existe con una definición incompatible.`,
      { index: INDEX, expected_fields: ['next_token_hash'], actual_fields: actualFields }
    );
  }
  return true;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const currentIndexes = await indexes(queryInterface);
    const hasCompatibleIndex = assertCompatibleIndex(currentIndexes);
    const columns = [
      ['next_token_hash', { type: Sequelize.STRING(64), allowNull: true }],
      ['next_token_prefix', { type: Sequelize.STRING(16), allowNull: true }],
      ['next_token_issued_at', { type: Sequelize.DATE, allowNull: true }],
      ['next_token_expires_at', { type: Sequelize.DATE, allowNull: true }],
    ];
    for (const [name, definition] of columns) {
      if (!await hasColumn(queryInterface, name)) {
        await queryInterface.addColumn(TABLE, name, definition);
      }
    }
    if (!hasCompatibleIndex) {
      await queryInterface.addIndex(TABLE, ['next_token_hash'], { name: INDEX, unique: true });
    }
    if (!assertCompatibleIndex(await indexes(queryInterface))) {
      throw migrationError(
        'web_wordpress_token_rotation_index_unconfirmed',
        `No se pudo confirmar la creación del índice ${INDEX}.`
      );
    }
  },

  async down(queryInterface) {
    const currentIndexes = await indexes(queryInterface);
    if (assertCompatibleIndex(currentIndexes)) {
      await queryInterface.removeIndex(TABLE, INDEX);
    }
    for (const column of ['next_token_expires_at', 'next_token_issued_at', 'next_token_prefix', 'next_token_hash']) {
      if (await hasColumn(queryInterface, column)) {
        await queryInterface.removeColumn(TABLE, column);
      }
    }
  },
};
