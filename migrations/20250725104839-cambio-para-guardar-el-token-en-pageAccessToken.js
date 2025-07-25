'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { ClinicMetaAsset } = require('../../models');
    
    console.log('🔄 Iniciando migración de tokens de página...');
    
    try {
      // Obtener todos los activos de tipo página de Facebook o Instagram business
      const assets = await ClinicMetaAsset.findAll({
        where: {
          assetType: ['facebook_page', 'instagram_business']
        }
      });
      
      console.log(`📊 Encontrados ${assets.length} activos para migrar`);
      
      let updatedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;
      
      // Procesar cada activo
      for (const asset of assets) {
        try {
          // Verificar si ya tiene pageAccessToken
          if (asset.pageAccessToken) {
            console.log(`⏭️ Activo ${asset.id} ya tiene pageAccessToken, omitiendo...`);
            skippedCount++;
            continue;
          }
          
          // Verificar si tiene asset_data con token
          if (asset.asset_data && asset.asset_data.access_token) {
            // Extraer token de asset_data
            const token = asset.asset_data.access_token;
            
            // Actualizar pageAccessToken
            await asset.update({
              pageAccessToken: token
            });
            
            console.log(`✅ Activo ${asset.id} actualizado con éxito`);
            updatedCount++;
          } else {
            console.log(`⚠️ Activo ${asset.id} no tiene token en asset_data, omitiendo...`);
            skippedCount++;
          }
        } catch (error) {
          console.error(`❌ Error al procesar activo ${asset.id}:`, error);
          errorCount++;
        }
      }
      
      console.log('📝 Resumen de migración:');
      console.log(`- Total activos: ${assets.length}`);
      console.log(`- Actualizados: ${updatedCount}`);
      console.log(`- Omitidos: ${skippedCount}`);
      console.log(`- Errores: ${errorCount}`);
      console.log('✅ Migración completada');
    } catch (error) {
      console.error('❌ Error en migración:', error);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    // No hacemos nada en down, ya que no queremos revertir esta migración
    console.log('⚠️ Esta migración no se puede revertir');
  }
};
