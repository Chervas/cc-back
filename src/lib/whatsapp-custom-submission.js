'use strict';
const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value ?? null;
}

// The technical identity is also the durable retry identity. Meta and the local
// unique index agree on WABA + name + language, including after process death.
function customSubmissionName(input) {
  const request = String(input.requestId || '').trim();
  if (request && !/^[a-zA-Z0-9_-]{16,128}$/.test(request)) {
    throw Object.assign(Error('template_request_id_invalid'), { code: 'template_request_id_invalid', statusCode: 400 });
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical({
    clinic: Number(input.clinicId), owner: Number(input.createdByUserId),
    display: String(input.displayName || '').trim(), body: String(input.bodyText || '').trim(),
    category: input.category || 'UTILITY', language: input.language || 'es',
    variables: input.variables || [], header: input.headerImageUrl || null,
    usage: input.templateUsage || null,
    replacement: (input.replacementTemplateIds || [input.replaceTemplateId || null]).slice().sort(),
    targets: [...new Set(input.targetWabaIds || [input.wabaId])].map(String).sort(),
  }))).digest('hex').slice(0, 40);
  return `cc_custom_${digest}`;
}

async function runCustomSubmission(input, { acquire, find, create, reconcile, enqueue }) {
  const name = input.technicalName || customSubmissionName(input);
  const lease = await acquire(input.wabaId);
  if (!lease.acquired) throw Object.assign(Error('template_submission_in_progress'), {
    code: 'template_submission_in_progress', statusCode: 409,
    details: ['Este intento se está comprobando. Vuelve a consultar sin cambiar la plantilla.'],
  });
  try {
    const existing = await find({ waba_id: input.wabaId, name, language: input.language || 'es' });
    if (existing) {
      if (Number(existing.created_by_user_id) !== Number(input.createdByUserId)
        || Number(existing.clinic_id || 0) !== Number(input.clinicId || 0)) {
        throw Object.assign(Error('template_owner_forbidden'), { code: 'template_owner_forbidden', statusCode: 403 });
      }
      if (existing.is_active === false || existing.is_active === 0 || existing.retired_at || existing.superseded_by_template_id) {
        throw Object.assign(Error('template_submission_retired'), { code: 'template_submission_retired', statusCode: 409,
          details: ['Esta versión ya se ha retirado. Actualiza el catálogo antes de editarla.'] });
      }
      if (existing.rejection_reason === 'custom_submission_not_started') {
        return await create({ ...input, technicalName: name, existingRow: existing });
      }
      const submitted = !!existing.meta_template_id;
      if (submitted) await reconcile(existing, input);
      else await enqueue(existing, input);
      return { row: existing, submitted, reused: true, outcome_unknown: !submitted };
    }
    return await create({ ...input, technicalName: name });
  } finally {
    await lease.release();
  }
}

module.exports = { customSubmissionName, runCustomSubmission };
