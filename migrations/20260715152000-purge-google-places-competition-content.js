'use strict';

/**
 * CANCELLED MIGRATION.
 *
 * The original version irreversibly removed the Google Places identities,
 * snapshots and heatmap cache used by Competition. The controller has since
 * authorised this product flow after review with the DPO, so executing that
 * purge would now contradict the active product decision.
 *
 * Keep the filename as an intentional no-op: Sequelize can record it as
 * applied during a normal migration run without either deleting data or
 * blocking later migrations. Historical/preflight context lives in the
 * architecture documentation, not in executable destructive SQL.
 */
module.exports = {
  async up() {},

  async down() {},
};
