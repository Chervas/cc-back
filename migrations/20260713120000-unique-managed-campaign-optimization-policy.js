'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('CampaignOptimizationPolicies', ['managed_campaign_id'], {
      name: 'uniq_campaign_optimization_policy_managed_campaign',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'CampaignOptimizationPolicies',
      'uniq_campaign_optimization_policy_managed_campaign',
    );
  },
};
