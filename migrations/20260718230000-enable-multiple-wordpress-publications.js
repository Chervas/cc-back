'use strict';

const TABLE = 'WebPublications';
const UNIQUE_INDEX = 'uniq_web_publications_wordpress_installation';
const ROUTE_INDEX = 'idx_web_publications_wordpress_status_path';

function migrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

async function indexes(queryInterface) {
  if (typeof queryInterface.showIndex !== 'function') {
    throw migrationError(
      'web_wordpress_multi_publication_introspection_unavailable',
      'No se pueden inspeccionar de forma segura los índices de WebPublications.'
    );
  }
  return queryInterface.showIndex(TABLE);
}

function hasIndex(rows, name) {
  return rows.some((row) => String(row?.name || '') === name);
}

function indexByName(rows, name) {
  return rows.find((row) => String(row?.name || '') === name) || null;
}

function indexFields(index) {
  return (Array.isArray(index?.fields) ? index.fields : [])
    .map((field) => String(field?.attribute || field?.name || field || ''));
}

function assertIndex(index, { name, unique, fields }) {
  if (!index) return;
  const actualFields = indexFields(index);
  if (Boolean(index.unique) !== unique || JSON.stringify(actualFields) !== JSON.stringify(fields)) {
    throw migrationError(
      'web_wordpress_multi_publication_index_incompatible',
      `El índice ${name} existe con una definición incompatible.`,
      { index: name, expected_fields: fields, actual_fields: actualFields }
    );
  }
}

function rowsFromQueryResult(result) {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

module.exports = {
  async up(queryInterface) {
    const current = await indexes(queryInterface);
    assertIndex(indexByName(current, UNIQUE_INDEX), {
      name: UNIQUE_INDEX, unique: true, fields: ['wordpress_installation_id'],
    });
    assertIndex(indexByName(current, ROUTE_INDEX), {
      name: ROUTE_INDEX, unique: false, fields: ['wordpress_installation_id', 'status', 'path'],
    });
    if (!hasIndex(current, ROUTE_INDEX)) {
      await queryInterface.addIndex(TABLE, ['wordpress_installation_id', 'status', 'path'], {
        name: ROUTE_INDEX,
      });
    }
    const refreshed = await indexes(queryInterface);
    const routeIndex = indexByName(refreshed, ROUTE_INDEX);
    assertIndex(routeIndex, {
      name: ROUTE_INDEX, unique: false, fields: ['wordpress_installation_id', 'status', 'path'],
    });
    if (!routeIndex) {
      throw migrationError(
        'web_wordpress_multi_publication_route_index_unconfirmed',
        `No se pudo confirmar la creación del índice ${ROUTE_INDEX}.`,
        { index: ROUTE_INDEX }
      );
    }
    assertIndex(indexByName(refreshed, UNIQUE_INDEX), {
      name: UNIQUE_INDEX, unique: true, fields: ['wordpress_installation_id'],
    });
    if (hasIndex(refreshed, UNIQUE_INDEX)) {
      await queryInterface.removeIndex(TABLE, UNIQUE_INDEX);
    }
  },

  async down(queryInterface, Sequelize) {
    const quotedTable = queryInterface.queryGenerator.quoteTable(TABLE);
    const quotedInstallation = queryInterface.queryGenerator.quoteIdentifier('wordpress_installation_id');
    const duplicateResult = await queryInterface.sequelize.query(
      `SELECT ${quotedInstallation} AS installation_id, COUNT(*) AS publication_count `
        + `FROM ${quotedTable} WHERE ${quotedInstallation} IS NOT NULL `
        + `GROUP BY ${quotedInstallation} HAVING COUNT(*) > 1 LIMIT 1`,
      { type: Sequelize.QueryTypes.SELECT, raw: true }
    );
    const [duplicates] = rowsFromQueryResult(duplicateResult);
    if (duplicates) {
      throw migrationError(
        'web_wordpress_multi_publication_down_forbidden',
        'No se puede restaurar el índice único: ya existen varias publicaciones en una instalación.',
        { installation_id: duplicates.installation_id, publication_count: Number(duplicates.publication_count) }
      );
    }
    const current = await indexes(queryInterface);
    assertIndex(indexByName(current, ROUTE_INDEX), {
      name: ROUTE_INDEX, unique: false, fields: ['wordpress_installation_id', 'status', 'path'],
    });
    assertIndex(indexByName(current, UNIQUE_INDEX), {
      name: UNIQUE_INDEX, unique: true, fields: ['wordpress_installation_id'],
    });
    if (!hasIndex(current, UNIQUE_INDEX)) {
      await queryInterface.addIndex(TABLE, ['wordpress_installation_id'], {
        name: UNIQUE_INDEX,
        unique: true,
      });
    }
    const refreshed = await indexes(queryInterface);
    assertIndex(indexByName(refreshed, ROUTE_INDEX), {
      name: ROUTE_INDEX, unique: false, fields: ['wordpress_installation_id', 'status', 'path'],
    });
    assertIndex(indexByName(refreshed, UNIQUE_INDEX), {
      name: UNIQUE_INDEX, unique: true, fields: ['wordpress_installation_id'],
    });
    if (hasIndex(refreshed, ROUTE_INDEX)) {
      await queryInterface.removeIndex(TABLE, ROUTE_INDEX);
    }
  },
};
