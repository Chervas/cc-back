'use strict';

/**
 * Places API content cannot be stored for the competition-monitoring use case
 * in the EEA. This migration deliberately cannot restore the removed provider
 * payloads: they must be re-entered by a user or supplied by a provider whose
 * licence permits persistence.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `DELETE snapshots
           FROM MarketingCompetitorSnapshots snapshots
           INNER JOIN MarketingCompetitors competitors
                   ON competitors.id = snapshots.competitor_id
          WHERE competitors.source = 'google_places'
             OR competitors.google_place_id IS NOT NULL`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `UPDATE MarketingCompetitors
            SET name = CONCAT('Competidor restringido ', id),
                source = 'google_places',
                google_place_id = NULL,
                google_maps_url = NULL,
                website_url = NULL,
                phone = NULL,
                address = NULL,
                city = NULL,
                latitude = NULL,
                longitude = NULL,
                primary_category = NULL,
                rating = NULL,
                review_count = NULL,
                business_status = NULL,
                meta_ads_search_terms = NULL,
                raw_place_payload = NULL,
                last_places_synced_at = NULL,
                last_sync_status = 'provider_restricted',
                last_sync_error = 'Reconfirmar manualmente o conectar un proveedor con licencia para inteligencia competitiva',
                is_active = 0
          WHERE source = 'google_places'
             OR google_place_id IS NOT NULL`,
        { transaction }
      );

      await queryInterface.bulkDelete('MarketingCompetitionHeatmapCaches', null, { transaction });
    });
  },

  async down() {
    // No permitimos que Sequelize marque como revertida una migración cuyos
    // datos no pueden restaurarse. Así el historial no queda mintiendo tras un
    // `db:migrate:undo` accidental.
    throw new Error('irreversible_migration: Google Places competition content cannot be restored');
  },
};
