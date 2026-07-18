'use strict';

const UNIQUE_NAME = 'uniq_campaign_optimization_policy_strategy';

module.exports = {
  async up(queryInterface) {
    const [duplicates] = await queryInterface.sequelize.query(`
      SELECT strategy_id, COUNT(*) AS total
      FROM CampaignOptimizationPolicies
      WHERE strategy_id IS NOT NULL
      GROUP BY strategy_id
      HAVING COUNT(*) > 1
      ORDER BY strategy_id ASC
      LIMIT 20
    `);
    if (duplicates.length) {
      const detail = duplicates.map((row) => `${row.strategy_id}:${row.total}`).join(', ');
      throw new Error(
        `No se puede crear ${UNIQUE_NAME}; hay políticas duplicadas por strategy_id (${detail}). `
        + 'El preflight no borra ni fusiona datos automáticamente.'
      );
    }

    const indexes = await queryInterface.showIndex('CampaignOptimizationPolicies');
    if (!indexes.some((index) => index.name === UNIQUE_NAME)) {
      await queryInterface.addIndex('CampaignOptimizationPolicies', ['strategy_id'], {
        name: UNIQUE_NAME,
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('CampaignOptimizationPolicies');
    if (indexes.some((index) => index.name === UNIQUE_NAME)) {
      await queryInterface.removeIndex('CampaignOptimizationPolicies', UNIQUE_NAME);
    }
  },
};
