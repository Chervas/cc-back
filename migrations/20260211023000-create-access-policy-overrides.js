'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AccessPolicyOverrides', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      scope_type: {
        type: Sequelize.ENUM('group', 'clinic'),
        allowNull: false,
      },
      scope_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      feature_key: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      role_code: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      effect: {
        type: Sequelize.ENUM('allow', 'deny'),
        allowNull: false,
      },
      updated_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('AccessPolicyOverrides', ['scope_type', 'scope_id', 'feature_key', 'role_code'], {
      unique: true,
      name: 'ux_access_policy_scope_feature_role',
    });

    await queryInterface.addIndex('AccessPolicyOverrides', ['feature_key', 'scope_type', 'scope_id'], {
      name: 'ix_access_policy_feature_scope',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('AccessPolicyOverrides', 'ix_access_policy_feature_scope');
    await queryInterface.removeIndex('AccessPolicyOverrides', 'ux_access_policy_scope_feature_role');
    await queryInterface.dropTable('AccessPolicyOverrides');

    // Limpiar ENUMs en MySQL
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_AccessPolicyOverrides_scope_type";').catch(() => {});
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_AccessPolicyOverrides_effect";').catch(() => {});
  },
};

