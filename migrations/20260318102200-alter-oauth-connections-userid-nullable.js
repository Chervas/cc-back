'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('MetaConnections', 'MetaConnections_ibfk_1');
    await queryInterface.changeColumn('MetaConnections', 'userId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      unique: true
    });
    await queryInterface.addConstraint('MetaConnections', {
      fields: ['userId'],
      type: 'foreign key',
      name: 'MetaConnections_ibfk_1',
      references: { table: 'Usuarios', field: 'id_usuario' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.removeConstraint('GoogleConnections', 'GoogleConnections_ibfk_1');
    await queryInterface.changeColumn('GoogleConnections', 'userId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      unique: true
    });
    await queryInterface.addConstraint('GoogleConnections', {
      fields: ['userId'],
      type: 'foreign key',
      name: 'GoogleConnections_ibfk_1',
      references: { table: 'Usuarios', field: 'id_usuario' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('MetaConnections', 'MetaConnections_ibfk_1');
    await queryInterface.changeColumn('MetaConnections', 'userId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      unique: true
    });
    await queryInterface.addConstraint('MetaConnections', {
      fields: ['userId'],
      type: 'foreign key',
      name: 'MetaConnections_ibfk_1',
      references: { table: 'Usuarios', field: 'id_usuario' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });

    await queryInterface.removeConstraint('GoogleConnections', 'GoogleConnections_ibfk_1');
    await queryInterface.changeColumn('GoogleConnections', 'userId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      unique: true
    });
    await queryInterface.addConstraint('GoogleConnections', {
      fields: ['userId'],
      type: 'foreign key',
      name: 'GoogleConnections_ibfk_1',
      references: { table: 'Usuarios', field: 'id_usuario' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });
  }
};
