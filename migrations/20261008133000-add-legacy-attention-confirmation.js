'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Operator-owned, per-clinic exception; deploying it grants nobody access.
    await queryInterface.addColumn('DoctorClinicas', 'allow_legacy_attention_confirmation', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS n FROM DoctorClinicas WHERE allow_legacy_attention_confirmation = 1',
    );
    if (Number(rows[0]?.n)) throw Error('legacy_attention_confirmation_rollback_requires_disabled_permissions');
    await queryInterface.removeColumn('DoctorClinicas', 'allow_legacy_attention_confirmation');
  },
};
