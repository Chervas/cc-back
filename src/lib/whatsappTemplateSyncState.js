'use strict';

const BLOCKED_CODES = new Set(['connection_blocked', 'connection_revoked', 'asset_revoked',
  'credential_revoked', 'whatsapp_authorized_scope_blocked', 'whatsapp_authorized_binding_invalid',
  'whatsapp_authorized_send_paused', 'whatsapp_template_connection_unavailable']);
const BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;

function blockedCode(error) {
  const code = typeof error === 'string' ? error : error?.code || error?.message;
  return BLOCKED_CODES.has(code) ? code : null;
}

async function recentJobs({ query, wabaIds, namespace, now = Date.now() }) {
  const ids = [...new Set(wabaIds.map(String).filter(Boolean))];
  if (!ids.length) return new Map();
  const [rows] = await query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ j.id,
    r.waba_id,j.status,j.error_message,j.updated_at,r.active_count
    FROM JobRequests j JOIN (
      SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.wabaId')) AS waba_id,MAX(id) AS latest_id,
        SUM(status IN ('pending','queued','running') OR
          (status='waiting' AND next_run_at<=:dueUntil)) AS active_count
      FROM JobRequests WHERE type='whatsapp_template_sync_delayed'
        AND created_at>=:lookback
        AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.__runtime_namespace'))=:namespace
        AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.wabaId')) IN (:wabaIds)
      GROUP BY waba_id
    ) r ON j.id=r.latest_id`, { replacements: { wabaIds: ids, namespace,
    lookback: new Date(now - 24 * 60 * 60 * 1000), dueUntil: new Date(now + 2 * 60 * 1000) } });
  return new Map(rows.map(row => [String(row.waba_id), row]));
}

function deferReason(job, now = Date.now()) {
  if (Number(job?.active_count) > 0) return 'sync_in_progress';
  const updatedAt = new Date(job?.updated_at || '').getTime();
  if (blockedCode(job?.error_message) && Number.isFinite(updatedAt)
    && now - updatedAt < BLOCKED_COOLDOWN_MS) return 'connection_blocked_cooldown';
  return null;
}

module.exports = { blockedCode, recentJobs, deferReason, BLOCKED_COOLDOWN_MS };
