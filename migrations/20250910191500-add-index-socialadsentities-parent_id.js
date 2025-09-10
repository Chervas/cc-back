'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    try {
      await queryInterface.addIndex('SocialAdsEntities', ['parent_id'], {
        name: 'idx_ads_entities_parent_id'
      });
      console.log('✅ Índice idx_ads_entities_parent_id creado');
    } catch (e) {
      console.warn('⚠️ No se pudo crear índice parent_id (puede existir):', e.message);
    }
  },
  down: async (queryInterface, Sequelize) => {
    try {
      await queryInterface.removeIndex('SocialAdsEntities', 'idx_ads_entities_parent_id');
      console.log('✅ Índice idx_ads_entities_parent_id eliminado');
    } catch (e) {
      console.warn('⚠️ No se pudo eliminar índice parent_id:', e.message);
    }
  }
};

