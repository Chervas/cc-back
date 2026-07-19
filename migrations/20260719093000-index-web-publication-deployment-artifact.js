'use strict';

const TABLE = 'WebPublicationDeployments';
const INDEX = 'idx_web_publication_deployments_artifact_status';
const FIELDS = ['artifact_id', 'status', 'publication_id'];

function migrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function indexFields(index) {
  return (Array.isArray(index?.fields) ? index.fields : [])
    .map((field) => String(field?.attribute || field?.name || field || ''));
}

function assertIndex(rows) {
  const index = rows.find((candidate) => String(candidate?.name || '') === INDEX);
  if (!index) return false;
  const actualFields = indexFields(index);
  if (Boolean(index.unique) || JSON.stringify(actualFields) !== JSON.stringify(FIELDS)) {
    throw migrationError(
      'web_publication_deployment_artifact_index_incompatible',
      `El índice ${INDEX} existe con una definición incompatible.`,
      { index: INDEX, expected_fields: FIELDS, actual_fields: actualFields }
    );
  }
  return true;
}

async function indexes(queryInterface) {
  if (typeof queryInterface.showIndex !== 'function') {
    throw migrationError(
      'web_publication_deployment_artifact_index_introspection_unavailable',
      `No se puede inspeccionar de forma segura ${TABLE}.`
    );
  }
  return queryInterface.showIndex(TABLE);
}

module.exports = {
  async up(queryInterface) {
    const current = await indexes(queryInterface);
    if (!assertIndex(current)) {
      await queryInterface.addIndex(TABLE, FIELDS, { name: INDEX });
    }
    if (!assertIndex(await indexes(queryInterface))) {
      throw migrationError(
        'web_publication_deployment_artifact_index_unconfirmed',
        `No se pudo confirmar la creación del índice ${INDEX}.`
      );
    }
  },

  async down(queryInterface) {
    const current = await indexes(queryInterface);
    if (assertIndex(current)) await queryInterface.removeIndex(TABLE, INDEX);
  },
};
