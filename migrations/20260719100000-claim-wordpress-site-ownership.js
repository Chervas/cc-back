'use strict';

const TABLE = 'WebWordpressInstallations';
const LEGACY_UNIQUE_INDEX = 'uniq_web_wordpress_site_url_hash';
const SITE_INDEX = 'idx_web_wordpress_site_url_hash';
const CLAIM_UNIQUE_INDEX = 'uniq_web_wordpress_claimed_site_hash';

function migrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function indexFields(index) {
  return (Array.isArray(index?.fields) ? index.fields : [])
    .map((field) => String(field?.attribute || field?.name || field || ''));
}

async function indexes(queryInterface) {
  if (typeof queryInterface.showIndex !== 'function') {
    throw migrationError(
      'web_wordpress_site_claim_introspection_unavailable',
      'No se pueden inspeccionar de forma segura los índices de WordPress.'
    );
  }
  return queryInterface.showIndex(TABLE);
}

function assertIndex(rows, name, fields, unique) {
  const found = rows.find((candidate) => String(candidate?.name || '') === name);
  if (!found) return false;
  const actual = indexFields(found);
  if (Boolean(found.unique) !== Boolean(unique) || JSON.stringify(actual) !== JSON.stringify(fields)) {
    throw migrationError(
      'web_wordpress_site_claim_index_incompatible',
      `El índice ${name} existe con una definición incompatible.`,
      { index: name, expected_fields: fields, actual_fields: actual, expected_unique: Boolean(unique) }
    );
  }
  return true;
}

async function tableColumns(queryInterface) {
  return queryInterface.describeTable(TABLE);
}

async function selectRows(queryInterface, Sequelize, sql) {
  return queryInterface.sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
}

async function assertNoConnectedDuplicates(queryInterface, Sequelize) {
  const table = queryInterface.queryGenerator.quoteTable(TABLE);
  const hash = queryInterface.queryGenerator.quoteIdentifier('site_url_hash');
  const status = queryInterface.queryGenerator.quoteIdentifier('status');
  const duplicates = await selectRows(
    queryInterface,
    Sequelize,
    `SELECT ${hash} AS site_url_hash, COUNT(*) AS installation_count FROM ${table} `
      + `WHERE ${status} IN ('connected','outdated') GROUP BY ${hash} HAVING COUNT(*) > 1 LIMIT 20`
  );
  if (duplicates.length) {
    throw migrationError(
      'web_wordpress_site_claim_connected_duplicates',
      'Hay WordPress conectados duplicados; se aborta antes de crear claims globales.',
      { duplicates: duplicates.map((row) => ({
        site_url_hash: String(row.site_url_hash || ''),
        installation_count: Number(row.installation_count || 0),
      })) }
    );
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // Preflight first: no schema/index mutation is allowed before proving that
    // the connected/outdated backfill can satisfy the new UNIQUE claim.
    await assertNoConnectedDuplicates(queryInterface, Sequelize);
    let currentIndexes = await indexes(queryInterface);
    const hasLegacyUnique = assertIndex(currentIndexes, LEGACY_UNIQUE_INDEX, ['site_url_hash'], true);
    const hasSiteIndex = assertIndex(currentIndexes, SITE_INDEX, ['site_url_hash'], false);
    const hasClaimUnique = assertIndex(currentIndexes, CLAIM_UNIQUE_INDEX, ['claimed_site_hash'], true);
    const columns = await tableColumns(queryInterface);
    const definitions = [
      ['claimed_site_hash', { type: Sequelize.STRING(64), allowNull: true }],
      ['site_claim_token_hash', { type: Sequelize.STRING(64), allowNull: true }],
      ['site_claim_issued_at', { type: Sequelize.DATE, allowNull: true }],
      ['site_claim_expires_at', { type: Sequelize.DATE, allowNull: true }],
      ['site_claimed_at', { type: Sequelize.DATE, allowNull: true }],
    ];
    for (const [name, definition] of definitions) {
      if (!columns[name]) await queryInterface.addColumn(TABLE, name, definition);
    }

    const table = queryInterface.queryGenerator.quoteTable(TABLE);
    const claimed = queryInterface.queryGenerator.quoteIdentifier('claimed_site_hash');
    const siteHash = queryInterface.queryGenerator.quoteIdentifier('site_url_hash');
    const status = queryInterface.queryGenerator.quoteIdentifier('status');
    const claimedAt = queryInterface.queryGenerator.quoteIdentifier('site_claimed_at');
    const lastSeen = queryInterface.queryGenerator.quoteIdentifier('last_seen_at');
    const updatedAt = queryInterface.queryGenerator.quoteIdentifier('updated_at');
    const createdAt = queryInterface.queryGenerator.quoteIdentifier('created_at');
    await queryInterface.sequelize.query(
      `UPDATE ${table} SET ${claimed} = ${siteHash}, `
        + `${claimedAt} = COALESCE(${claimedAt}, ${lastSeen}, ${updatedAt}, ${createdAt}, CURRENT_TIMESTAMP) `
        + `WHERE ${status} IN ('connected','outdated') AND ${claimed} IS NULL`
    );
    await queryInterface.sequelize.query(
      `UPDATE ${table} SET ${claimed} = NULL WHERE ${status} IN ('pending','revoked')`
    );

    // MySQL DDL autocommits. Establish and re-read the stronger connected-only
    // UNIQUE before removing the legacy uniqueness, so a failed migration can
    // never leave connected claims unprotected.
    if (!hasClaimUnique) {
      await queryInterface.addIndex(TABLE, ['claimed_site_hash'], { name: CLAIM_UNIQUE_INDEX, unique: true });
    }
    currentIndexes = await indexes(queryInterface);
    assertIndex(currentIndexes, CLAIM_UNIQUE_INDEX, ['claimed_site_hash'], true);
    if (hasLegacyUnique) await queryInterface.removeIndex(TABLE, LEGACY_UNIQUE_INDEX);
    if (!hasSiteIndex) await queryInterface.addIndex(TABLE, ['site_url_hash'], { name: SITE_INDEX, unique: false });
    currentIndexes = await indexes(queryInterface);
    assertIndex(currentIndexes, SITE_INDEX, ['site_url_hash'], false);
    assertIndex(currentIndexes, CLAIM_UNIQUE_INDEX, ['claimed_site_hash'], true);
    if (currentIndexes.some((index) => String(index?.name || '') === LEGACY_UNIQUE_INDEX)) {
      throw migrationError(
        'web_wordpress_site_claim_legacy_unique_present',
        'El índice antiguo sigue reservando URLs desde el estado pending.'
      );
    }
  },

  async down(queryInterface, Sequelize) {
    const table = queryInterface.queryGenerator.quoteTable(TABLE);
    const rows = await selectRows(queryInterface, Sequelize, `SELECT COUNT(*) AS installation_count FROM ${table}`);
    const count = Number(rows[0]?.installation_count || 0);
    if (count > 0) {
      throw migrationError(
        'web_wordpress_site_claim_down_blocked',
        'No se puede retirar el control de propiedad mientras existan instalaciones WordPress.',
        { installation_count: count }
      );
    }
    let currentIndexes = await indexes(queryInterface);
    if (!assertIndex(currentIndexes, LEGACY_UNIQUE_INDEX, ['site_url_hash'], true)) {
      await queryInterface.addIndex(TABLE, ['site_url_hash'], { name: LEGACY_UNIQUE_INDEX, unique: true });
    }
    currentIndexes = await indexes(queryInterface);
    assertIndex(currentIndexes, LEGACY_UNIQUE_INDEX, ['site_url_hash'], true);
    if (assertIndex(currentIndexes, CLAIM_UNIQUE_INDEX, ['claimed_site_hash'], true)) {
      await queryInterface.removeIndex(TABLE, CLAIM_UNIQUE_INDEX);
    }
    if (assertIndex(currentIndexes, SITE_INDEX, ['site_url_hash'], false)) {
      await queryInterface.removeIndex(TABLE, SITE_INDEX);
    }
    const columns = await tableColumns(queryInterface);
    for (const name of [
      'site_claimed_at',
      'site_claim_expires_at',
      'site_claim_issued_at',
      'site_claim_token_hash',
      'claimed_site_hash',
    ]) {
      if (columns[name]) await queryInterface.removeColumn(TABLE, name);
    }
  },

  assertNoConnectedDuplicates,
  migrationError,
};
