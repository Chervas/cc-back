'use strict';

const db = require('../../models');
const whatsappAccountHealthService = require('../services/whatsappAccountHealth.service');

function countStates(rows = []) {
  return rows.reduce((summary, row) => {
    const state = row?.health?.state || 'unknown';
    summary[state] = Number(summary[state] || 0) + 1;
    return summary;
  }, {});
}

async function preview({ activeOnly }) {
  const assets = await db.ClinicMetaAsset.findAll({
    where: {
      assetType: 'whatsapp_phone_number',
      ...(activeOnly ? { isActive: true } : {}),
    },
    attributes: ['id', 'isActive', 'quality_rating', 'additionalData', 'updatedAt'],
  });
  return {
    processed: assets.length,
    states: assets.reduce((summary, asset) => {
      const state = whatsappAccountHealthService.summarizeAssetHealth(asset).base_state || 'unknown';
      summary[state] = Number(summary[state] || 0) + 1;
      return summary;
    }, {}),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const activeOnly = !process.argv.includes('--include-inactive');
  const result = apply
    ? await whatsappAccountHealthService.reconcileStoredHealth({ activeOnly })
    : await preview({ activeOnly });

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    active_only: activeOnly,
    processed: result.processed,
    states: apply ? countStates(result.results) : result.states,
  }));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      error: error?.code || error?.message || 'whatsapp_health_reconciliation_failed',
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close().catch(() => null);
  });
