'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Presentation only. Historical rooms retain their existing type fallback.
    await queryInterface.addColumn('Instalaciones', 'icono', {
      type: Sequelize.STRING(96), allowNull: true, defaultValue: null,
    });
    // Keep professional treatment separate from the person's display name.
    await queryInterface.addColumn('Usuarios', 'tratamiento_profesional', {
      type: Sequelize.STRING(8), allowNull: true, defaultValue: null,
    });
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS n FROM Instalaciones WHERE icono IS NOT NULL',
    );
    const [users] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS n FROM Usuarios WHERE tratamiento_profesional IS NOT NULL',
    );
    if (Number(rows[0]?.n) || Number(users[0]?.n)) throw Error('room_presentation_rollback_requires_cleared_preferences');
    await queryInterface.removeColumn('Instalaciones', 'icono');
    await queryInterface.removeColumn('Usuarios', 'tratamiento_profesional');
  },
};
