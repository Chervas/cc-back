'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    console.log('🔄 Iniciando migración: Agregar campos a ClinicMetaAssets...');

    // 1. Agregar campo assetAvatarUrl
    await queryInterface.addColumn('ClinicMetaAssets', 'assetAvatarUrl', {
      type: Sequelize.STRING(512),
      allowNull: true,
      comment: 'URL del avatar/icono del activo (página, perfil, etc.)'
    });
    console.log('✅ Campo assetAvatarUrl agregado');

    // 2. Agregar campo additionalData
    await queryInterface.addColumn('ClinicMetaAssets', 'additionalData', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Datos adicionales del activo (followers, categoría, verificación, etc.)'
    });
    console.log('✅ Campo additionalData agregado');

    // 3. Agregar campo isActive
    await queryInterface.addColumn('ClinicMetaAssets', 'isActive', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Si el mapeo está activo o deshabilitado'
    });
    console.log('✅ Campo isActive agregado');

    // 4. Convertir assetType a ENUM (si no es ya ENUM)
    try {
      // Verificar si ya es ENUM
      const tableInfo = await queryInterface.describeTable('ClinicMetaAssets');
      const assetTypeColumn = tableInfo.assetType;
      
      if (assetTypeColumn.type !== 'ENUM') {
        console.log('🔄 Convirtiendo assetType a ENUM...');
        
        // Crear columna temporal ENUM
        await queryInterface.addColumn('ClinicMetaAssets', 'assetType_new', {
          type: Sequelize.ENUM('facebook_page', 'instagram_business', 'ad_account'),
          allowNull: false,
          defaultValue: 'facebook_page'
        });

        // Copiar datos validando valores
        await queryInterface.sequelize.query(`
          UPDATE ClinicMetaAssets 
          SET assetType_new = CASE 
            WHEN assetType = 'facebook_page' THEN 'facebook_page'
            WHEN assetType = 'instagram_business' THEN 'instagram_business' 
            WHEN assetType = 'ad_account' THEN 'ad_account'
            ELSE 'facebook_page'
          END
        `);

        // Eliminar columna antigua
        await queryInterface.removeColumn('ClinicMetaAssets', 'assetType');

        // Renombrar nueva columna
        await queryInterface.renameColumn('ClinicMetaAssets', 'assetType_new', 'assetType');
        
        console.log('✅ assetType convertido a ENUM');
      } else {
        console.log('ℹ️ assetType ya es ENUM, saltando conversión');
      }
    } catch (error) {
      console.log('⚠️ Error convirtiendo assetType a ENUM:', error.message);
      console.log('ℹ️ Continuando con otros cambios...');
    }

    // 5. Agregar índices optimizados
    try {
      await queryInterface.addIndex('ClinicMetaAssets', ['isActive'], {
        name: 'idx_clinic_meta_assets_is_active'
      });
      console.log('✅ Índice isActive agregado');
    } catch (error) {
      console.log('ℹ️ Índice isActive ya existe o error:', error.message);
    }

    try {
      await queryInterface.addIndex('ClinicMetaAssets', ['assetType', 'isActive'], {
        name: 'idx_clinic_meta_assets_type_active'
      });
      console.log('✅ Índice assetType+isActive agregado');
    } catch (error) {
      console.log('ℹ️ Índice assetType+isActive ya existe o error:', error.message);
    }

    try {
      await queryInterface.addIndex('ClinicMetaAssets', ['clinicaId', 'isActive'], {
        name: 'idx_clinic_meta_assets_clinica_active'
      });
      console.log('✅ Índice clinicaId+isActive agregado');
    } catch (error) {
      console.log('ℹ️ Índice clinicaId+isActive ya existe o error:', error.message);
    }

    // 6. Actualizar registros existentes para que tengan isActive = true
    await queryInterface.sequelize.query(`
      UPDATE ClinicMetaAssets 
      SET isActive = true 
      WHERE isActive IS NULL
    `);
    console.log('✅ Registros existentes actualizados con isActive = true');

    console.log('🎉 Migración completada exitosamente');
  },

  async down(queryInterface, Sequelize) {
    console.log('🔄 Revirtiendo migración: Eliminar campos de ClinicMetaAssets...');

    // Eliminar índices agregados
    try {
      await queryInterface.removeIndex('ClinicMetaAssets', 'idx_clinic_meta_assets_is_active');
      await queryInterface.removeIndex('ClinicMetaAssets', 'idx_clinic_meta_assets_type_active');
      await queryInterface.removeIndex('ClinicMetaAssets', 'idx_clinic_meta_assets_clinica_active');
      console.log('✅ Índices eliminados');
    } catch (error) {
      console.log('ℹ️ Error eliminando índices:', error.message);
    }

    // Revertir assetType a VARCHAR si fue convertido
    try {
      await queryInterface.addColumn('ClinicMetaAssets', 'assetType_old', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: 'facebook_page'
      });

      await queryInterface.sequelize.query(`
        UPDATE ClinicMetaAssets 
        SET assetType_old = assetType
      `);

      await queryInterface.removeColumn('ClinicMetaAssets', 'assetType');
      await queryInterface.renameColumn('ClinicMetaAssets', 'assetType_old', 'assetType');
      console.log('✅ assetType revertido a VARCHAR');
    } catch (error) {
      console.log('ℹ️ Error revirtiendo assetType:', error.message);
    }

    // Eliminar campos agregados
    await queryInterface.removeColumn('ClinicMetaAssets', 'isActive');
    await queryInterface.removeColumn('ClinicMetaAssets', 'additionalData');
    await queryInterface.removeColumn('ClinicMetaAssets', 'assetAvatarUrl');

    console.log('✅ Rollback completado');
  }
};

