'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('GoogleAdsConversionUploadAttempts', 'status', {
      type: Sequelize.ENUM('pending', 'accepted', 'succeeded', 'partial_success', 'failed', 'skipped'),
      allowNull: false,
      defaultValue: 'pending'
    });
    await queryInterface.changeColumn('GoogleAdsConversionUploadAttempts', 'click_id_type', {
      type: Sequelize.ENUM('gclid', 'gbraid', 'wbraid'),
      allowNull: true
    });
    await queryInterface.changeColumn('GoogleAdsConversionUploadAttempts', 'click_id_hash', {
      type: Sequelize.STRING(64),
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      "UPDATE GoogleAdsConversionUploadAttempts SET status = 'succeeded' WHERE status IN ('accepted', 'partial_success')"
    );
    await queryInterface.changeColumn('GoogleAdsConversionUploadAttempts', 'status', {
      type: Sequelize.ENUM('pending', 'succeeded', 'failed', 'skipped'),
      allowNull: false,
      defaultValue: 'pending'
    });
    // Los intentos basados solo en UserData se conservan. Las columnas quedan
    // anulables al revertir para no inventar click IDs ni borrar auditoría.
  }
};
