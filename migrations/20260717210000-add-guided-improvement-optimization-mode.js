'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('CampaignOptimizationPolicies', 'mode', {
      type: Sequelize.ENUM('connect_only', 'guided_improvement', 'managed_service'),
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    const [rows] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS total FROM CampaignOptimizationPolicies WHERE mode = 'guided_improvement'"
    );
    if (Number(rows?.[0]?.total || 0) > 0) {
      throw new Error('No se puede retirar guided_improvement mientras existan políticas que lo usan');
    }
    await queryInterface.changeColumn('CampaignOptimizationPolicies', 'mode', {
      type: Sequelize.ENUM('connect_only', 'managed_service'),
      allowNull: false,
    });
  },
};
