'use strict';

const MIGRATION_ID = '20260712102000';

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function scopeKey(payload, fallbackClinicId = null) {
  const scope = objectValue(payload?.scope);
  if (String(scope.assignment_scope || '').trim().toLowerCase() === 'group') {
    const groupId = positiveInt(scope.group_id);
    return groupId ? `group:${groupId}` : null;
  }
  const clinicId = positiveInt(scope.clinic_id) || positiveInt(fallbackClinicId);
  return clinicId ? `clinic:${clinicId}` : null;
}

function usesGoogleAds(payload) {
  const channels = Array.isArray(payload?.channels) ? payload.channels : [];
  return channels.some((channel) => (
    String(channel?.channel || channel || '').trim().toLowerCase() === 'google_ads'
      && (typeof channel !== 'object' || channel?.enabled !== false)
  )) || payload?.measurement?.channel_native?.google_ads_conversions === true;
}

function verifiedConversionStep(payload) {
  if (payload?.kind !== 'campaign_onboarding' || payload?.status !== 'completed') return null;
  const step = (Array.isArray(payload.steps) ? payload.steps : [])
    .find((candidate) => candidate?.key === 'conversion_actions');
  return step?.status === 'done' && step?.readiness?.validated === true ? step : null;
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [rows] = await sequelize.query(`
        SELECT id, campaign_id, clinica_id, estado, solicitud
        FROM CampaignRequests
        ORDER BY id ASC
      `, { transaction });
      const verifiedScopes = new Map();

      for (const row of rows) {
        const payload = objectValue(row.solicitud);
        const verifiedStep = verifiedConversionStep(payload);
        const key = verifiedStep ? scopeKey(payload, row.clinica_id) : null;
        if (!key) continue;
        verifiedScopes.set(key, {
          validated_at: payload.completed_at || payload.updated_at || null,
          enabled_events: verifiedStep.readiness?.enabled_events || [],
          customer_ids: verifiedStep.readiness?.customer_ids || []
        });
      }

      const normalizedOnboardingIds = new Set();
      for (const row of rows) {
        const payload = objectValue(row.solicitud);
        const providers = Array.isArray(payload.providers) ? payload.providers : [];
        const steps = Array.isArray(payload.steps) ? [...payload.steps] : [];
        const conversionStepIndex = steps.findIndex((step) => step?.key === 'conversion_actions');
        const conversionStep = conversionStepIndex >= 0 ? objectValue(steps[conversionStepIndex]) : {};
        if (
          payload.kind !== 'campaign_onboarding'
          || payload.status !== 'completed'
          || String(payload.mode || '').trim().toLowerCase() !== 'connect_only'
          || !providers.includes('google_ads')
          || conversionStep?.readiness?.validated === true
        ) continue;

        const nowIso = new Date().toISOString();
        if (conversionStepIndex >= 0) {
          steps[conversionStepIndex] = {
            ...conversionStep,
            status: 'pending',
            reason: 'legacy_conversion_readiness_not_verified',
            readiness: {
              ...(objectValue(conversionStep.readiness)),
              ready: false,
              validated: false,
              normalized_by: MIGRATION_ID
            }
          };
        }
        const nextPayload = {
          ...payload,
          status: 'pending',
          current_step: 'conversion_actions',
          steps,
          readiness_normalization: {
            normalized_by: MIGRATION_ID,
            normalized_at: nowIso,
            previous_status: 'completed',
            previous_current_step: payload.current_step || null,
            previous_estado: row.estado,
            previous_conversion_step: conversionStepIndex >= 0 ? conversionStep : null
          }
        };
        await sequelize.query(`
          UPDATE CampaignRequests
          SET estado = 'en_creacion', solicitud = :payload
          WHERE id = :id
        `, {
          replacements: { id: row.id, payload: JSON.stringify(nextPayload) },
          transaction
        });
        normalizedOnboardingIds.add(positiveInt(row.id));
      }

      if (normalizedOnboardingIds.size) {
        const [intakeRows] = await sequelize.query(`SELECT id, config FROM IntakeConfigs`, { transaction });
        for (const intakeRow of intakeRows) {
          const config = objectValue(intakeRow.config);
          const campaigns = objectValue(config.campaigns);
          if (!normalizedOnboardingIds.has(positiveInt(campaigns.last_onboarding_id))) continue;
          await sequelize.query(`UPDATE IntakeConfigs SET config = :config WHERE id = :id`, {
            replacements: {
              id: intakeRow.id,
              config: JSON.stringify({
                ...config,
                campaigns: {
                  ...campaigns,
                  active_mode: null,
                  readiness_normalization: {
                    normalized_by: MIGRATION_ID,
                    previous_active_mode: campaigns.active_mode || null
                  }
                }
              })
            },
            transaction
          });
        }
      }

      for (const row of rows) {
        const payload = objectValue(row.solicitud);
        const mode = String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase();
        if (
          payload.kind !== 'marketing_strategy'
          || mode !== 'connect_only'
          || String(payload.status || '').trim().toLowerCase() !== 'active'
          || !usesGoogleAds(payload)
          || payload?.activation_readiness?.validated === true
        ) continue;

        const key = scopeKey(payload, row.clinica_id);
        const verified = key ? verifiedScopes.get(key) : null;
        if (verified) {
          await sequelize.query(`
            UPDATE CampaignRequests
            SET solicitud = :payload
            WHERE id = :id
          `, {
            replacements: {
              id: row.id,
              payload: JSON.stringify({
                ...payload,
                activation_readiness: {
                  ready: true,
                  validated: true,
                  validate_only: true,
                  validated_at: verified.validated_at,
                  enabled_events: verified.enabled_events,
                  customer_ids: verified.customer_ids,
                  backfilled_by: MIGRATION_ID
                }
              })
            },
            transaction
          });
          continue;
        }

        const nowIso = new Date().toISOString();
        const nextPayload = {
          ...payload,
          activation_readiness: {
            ready: false,
            validated: false,
            reason: 'conversion_readiness_not_verified',
            normalized_by: MIGRATION_ID,
            normalized_at: nowIso
          },
          activation_readiness_normalization: {
            normalized_by: MIGRATION_ID,
            previous_activation_readiness: payload.activation_readiness || null
          }
        };
        await sequelize.query(`UPDATE CampaignRequests SET solicitud = :payload WHERE id = :id`, {
          replacements: { id: row.id, payload: JSON.stringify(nextPayload) },
          transaction
        });
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [rows] = await sequelize.query(`
        SELECT id, campaign_id, solicitud
        FROM CampaignRequests
      `, { transaction });
      for (const row of rows) {
        const payload = objectValue(row.solicitud);
        const onboardingNormalization = objectValue(payload.readiness_normalization);
        if (onboardingNormalization.normalized_by === MIGRATION_ID) {
          const steps = Array.isArray(payload.steps) ? [...payload.steps] : [];
          const conversionStepIndex = steps.findIndex((step) => step?.key === 'conversion_actions');
          if (conversionStepIndex >= 0 && onboardingNormalization.previous_conversion_step) {
            steps[conversionStepIndex] = onboardingNormalization.previous_conversion_step;
          }
          delete payload.readiness_normalization;
          payload.status = onboardingNormalization.previous_status || 'completed';
          payload.current_step = onboardingNormalization.previous_current_step || null;
          payload.steps = steps;
          await sequelize.query(`
            UPDATE CampaignRequests
            SET estado = :estado, solicitud = :payload
            WHERE id = :id
          `, {
            replacements: {
              id: row.id,
              estado: onboardingNormalization.previous_estado || 'aprobada',
              payload: JSON.stringify(payload)
            },
            transaction
          });
          continue;
        }
        const readiness = objectValue(payload.activation_readiness);
        if (readiness.backfilled_by === MIGRATION_ID) {
          delete payload.activation_readiness;
          delete payload.activation_readiness_normalization;
          await sequelize.query(`UPDATE CampaignRequests SET solicitud = :payload WHERE id = :id`, {
            replacements: { id: row.id, payload: JSON.stringify(payload) },
            transaction
          });
          continue;
        }
        const strategyNormalization = objectValue(payload.activation_readiness_normalization);
        if (readiness.normalized_by !== MIGRATION_ID || strategyNormalization.normalized_by !== MIGRATION_ID) continue;
        payload.activation_readiness = strategyNormalization.previous_activation_readiness || null;
        delete payload.activation_readiness_normalization;
        await sequelize.query(`UPDATE CampaignRequests SET solicitud = :payload WHERE id = :id`, {
          replacements: { id: row.id, payload: JSON.stringify(payload) },
          transaction
        });
      }


      const [intakeRows] = await sequelize.query(`SELECT id, config FROM IntakeConfigs`, { transaction });
      for (const intakeRow of intakeRows) {
        const config = objectValue(intakeRow.config);
        const campaigns = objectValue(config.campaigns);
        const normalization = objectValue(campaigns.readiness_normalization);
        if (normalization.normalized_by !== MIGRATION_ID) continue;
        delete campaigns.readiness_normalization;
        campaigns.active_mode = normalization.previous_active_mode || null;
        await sequelize.query(`UPDATE IntakeConfigs SET config = :config WHERE id = :id`, {
          replacements: {
            id: intakeRow.id,
            config: JSON.stringify({ ...config, campaigns })
          },
          transaction
        });
      }
    });
  }
};
