'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    try {
      console.log('🔄 Iniciando migración para extraer tokens de página...');
      
      // Obtener todos los activos de tipo página de Facebook o Instagram business
      const assets = await queryInterface.sequelize.query(
        `SELECT id, assetType, additionalData FROM ClinicMetaAssets WHERE assetType IN ('facebook_page', 'instagram_business')`,
        { type: queryInterface.sequelize.QueryTypes.SELECT }
      );
      
      console.log(`📊 Encontrados ${assets.length} activos para procesar`);
      
      let updatedCount = 0;
      let skippedCount = 0;
      
      // Procesar cada activo
      for (const asset of assets) {
        try {
          // Verificar si tiene additionalData con token
          if (asset.additionalData) {
            let additionalData = asset.additionalData;
            
            // Si additionalData ya es un objeto JSON (MySQL 8+), no necesitamos parsearlo
            if (typeof additionalData === 'string') {
              try {
                additionalData = JSON.parse(additionalData);
              } catch (e) {
                console.log(`⚠️ Activo ${asset.id} tiene additionalData que no es JSON válido, omitiendo...`);
                skippedCount++;
                continue;
              }
            }
            
            // Verificar si hay token en additionalData.access_token
            if (additionalData && additionalData.access_token) {
              // Actualizar pageAccessToken
              await queryInterface.sequelize.query(
                `UPDATE ClinicMetaAssets SET pageAccessToken = ? WHERE id = ?`,
                {
                  replacements: [additionalData.access_token, asset.id],
                  type: queryInterface.sequelize.QueryTypes.UPDATE
                }
              );
              
              console.log(`✅ Activo ${asset.id} (${asset.assetType}) actualizado con éxito`);
              updatedCount++;
            } else {
              console.log(`⚠️ Activo ${asset.id} (${asset.assetType}) no tiene token en additionalData, omitiendo...`);
              skippedCount++;
            }
          } else {
            console.log(`⚠️ Activo ${asset.id} (${asset.assetType}) no tiene additionalData, omitiendo...`);
            skippedCount++;
          }
        } catch (error) {
          console.error(`❌ Error al procesar activo ${asset.id}:`, error);
        }
      }
      
      console.log('📝 Resumen de migración:');
      console.log(`- Total activos: ${assets.length}`);
      console.log(`- Actualizados: ${updatedCount}`);
      console.log(`- Omitidos: ${skippedCount}`);
      console.log('✅ Migración completada');
      
      return Promise.resolve();
    } catch (error) {
      console.error('❌ Error en migración:', error);
      return Promise.reject(error);
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Revertir cambios (establecer pageAccessToken a NULL)
    try {
      await queryInterface.sequelize.query(
        `UPDATE ClinicMetaAssets SET pageAccessToken = NULL WHERE assetType IN ('facebook_page', 'instagram_business')`,
        { type: queryInterface.sequelize.QueryTypes.UPDATE }
      );
      
      console.log('✅ Tokens de página revertidos a NULL exitosamente');
      return Promise.resolve();
    } catch (error) {
      console.error('❌ Error al revertir migración:', error);
      return Promise.reject(error);
    }
  }
};
