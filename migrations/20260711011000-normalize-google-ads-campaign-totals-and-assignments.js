'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // El fallback actual identifica explícitamente los totales de campaña.
    // Si ya existe la versión normalizada, la fila legacy NULL es el mismo
    // snapshot y debe desaparecer para no duplicar inversión y clics.
    await sequelize.query(`
      DELETE legacy
      FROM GoogleAdsInsightsDaily AS legacy
      INNER JOIN GoogleAdsInsightsDaily AS normalized
        ON normalized.campaignId = legacy.campaignId
       AND normalized.date = legacy.date
       AND normalized.clinicGoogleAdsAccountId = legacy.clinicGoogleAdsAccountId
       AND normalized.adGroupId IS NULL
       AND normalized.network = 'CAMPAIGN_TOTAL'
       AND normalized.device = 'CAMPAIGN_TOTAL'
      WHERE legacy.adGroupId IS NULL
        AND legacy.network IS NULL
        AND legacy.device IS NULL
    `);

    // Conserva el histórico que todavía no se ha resincronizado, pero con la
    // dimensión canónica para que futuros upserts sean idempotentes.
    await sequelize.query(`
      UPDATE GoogleAdsInsightsDaily
      SET network = 'CAMPAIGN_TOTAL', device = 'CAMPAIGN_TOTAL'
      WHERE adGroupId IS NULL AND network IS NULL AND device IS NULL
    `);

    // Las asociaciones revisadas son la fuente canónica de atribución por
    // clínica, también para el histórico ya almacenado.
    await sequelize.query(`
      UPDATE GoogleAdsInsightsDaily AS insights
      INNER JOIN ExternalCampaignAssignments AS assignment
        ON assignment.provider = 'google_ads'
       AND assignment.customer_id = insights.customerId
       AND assignment.campaign_id = insights.campaignId
       AND assignment.status = 'active'
      SET insights.clinicaId = assignment.clinica_id,
          insights.grupoClinicaId = assignment.grupo_clinica_id,
          insights.clinicMatchSource = 'reviewed_campaign',
          insights.clinicMatchValue = assignment.match_kind
    `);
  },

  async down() {
    // Limpieza de datos deliberadamente irreversible: reintroducir duplicados
    // o borrar atribuciones revisadas dañaría las métricas.
  }
};
