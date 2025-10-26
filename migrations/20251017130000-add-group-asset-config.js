'use strict';

/**
 * Añade columnas de configuración para activos adicionales a nivel de grupo.
 * Incluye modos (grupo vs clínica) y referencias al activo primario cuando
 * el grupo comparte un único recurso.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Helper para añadir columna ENUM modo group/clinic
      const addModeColumn = async (columnName) => {
        await queryInterface.addColumn(
          'GruposClinicas',
          columnName,
          {
            type: Sequelize.ENUM('group', 'clinic'),
            allowNull: false,
            defaultValue: 'clinic'
          },
          { transaction }
        );
      };

      // Helper para añadir columna de referencia a activo primario
      const addPrimaryColumn = async (columnName, referencedTable = null) => {
        const column = {
          type: Sequelize.INTEGER,
          allowNull: true
        };

        if (referencedTable) {
          column.references = {
            model: referencedTable,
            key: 'id'
          };
          column.onUpdate = 'CASCADE';
          column.onDelete = 'SET NULL';
        }

        await queryInterface.addColumn('GruposClinicas', columnName, column, { transaction });
      };

      const addTimestampColumn = async (columnName) => {
        await queryInterface.addColumn(
          'GruposClinicas',
          columnName,
          {
            type: Sequelize.DATE,
            allowNull: true
          },
          { transaction }
        );
      };

      // Meta (Facebook / Instagram / TikTok reservado)
      await addModeColumn('facebook_assignment_mode');
      await addPrimaryColumn('facebook_primary_asset_id', 'ClinicMetaAssets');
      await addTimestampColumn('facebook_assignment_updated_at');

      await addModeColumn('instagram_assignment_mode');
      await addPrimaryColumn('instagram_primary_asset_id', 'ClinicMetaAssets');
      await addTimestampColumn('instagram_assignment_updated_at');

      await addModeColumn('tiktok_assignment_mode');
      // Reservado: no existe tabla de activos propia todavía
      await addPrimaryColumn('tiktok_primary_asset_id');
      await addTimestampColumn('tiktok_assignment_updated_at');

      // Google – Search Console
      await addModeColumn('search_console_assignment_mode');
      await addPrimaryColumn('search_console_primary_asset_id', 'ClinicWebAssets');
      await addTimestampColumn('search_console_assignment_updated_at');

      // Google – Analytics (GA4)
      await addModeColumn('analytics_assignment_mode');
      await addPrimaryColumn('analytics_primary_property_id', 'ClinicAnalyticsProperties');
      await addTimestampColumn('analytics_assignment_updated_at');

      // Google – Business Profile
      await addModeColumn('business_profile_assignment_mode');
      await addPrimaryColumn('business_profile_primary_location_id', 'ClinicBusinessLocations');
      await addTimestampColumn('business_profile_assignment_updated_at');

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const removeColumn = (columnName) =>
        queryInterface.removeColumn('GruposClinicas', columnName, { transaction });

      await removeColumn('business_profile_assignment_updated_at');
      await removeColumn('business_profile_primary_location_id');
      await removeColumn('business_profile_assignment_mode');

      await removeColumn('analytics_assignment_updated_at');
      await removeColumn('analytics_primary_property_id');
      await removeColumn('analytics_assignment_mode');

      await removeColumn('search_console_assignment_updated_at');
      await removeColumn('search_console_primary_asset_id');
      await removeColumn('search_console_assignment_mode');

      await removeColumn('tiktok_assignment_updated_at');
      await removeColumn('tiktok_primary_asset_id');
      await removeColumn('tiktok_assignment_mode');

      await removeColumn('instagram_assignment_updated_at');
      await removeColumn('instagram_primary_asset_id');
      await removeColumn('instagram_assignment_mode');

      await removeColumn('facebook_assignment_updated_at');
      await removeColumn('facebook_primary_asset_id');
      await removeColumn('facebook_assignment_mode');

      // Limpiar ENUMs manualmente (PostgreSQL mantiene los tipos)
      await queryInterface.sequelize.query(
        `DO $$
         DECLARE
           rec RECORD;
         BEGIN
           FOR rec IN
             SELECT t.typname
             FROM pg_type t
             WHERE t.typname IN (
               'enum_GruposClinicas_facebook_assignment_mode',
               'enum_GruposClinicas_instagram_assignment_mode',
               'enum_GruposClinicas_tiktok_assignment_mode',
               'enum_GruposClinicas_search_console_assignment_mode',
               'enum_GruposClinicas_analytics_assignment_mode',
               'enum_GruposClinicas_business_profile_assignment_mode'
             )
           LOOP
             EXECUTE format('DROP TYPE IF EXISTS %I', rec.typname);
           END LOOP;
         END $$;`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
