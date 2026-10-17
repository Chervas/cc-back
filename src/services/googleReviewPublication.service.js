'use strict';

const positiveId = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
};

// Local observations only. An unmatched or stale feed is never proof of non-publication.
async function checkStoredPublication(db, { clinicId, listId, itemId, locationIds = [], now = new Date() }, scoreNameMatch) {
  const checkedAt = new Date(now);
  const result = (state, reason, extra = {}) => ({ state, reason, checked_at: Number.isFinite(+checkedAt) ? checkedAt.toISOString() : null, source: 'stored_google_reviews', ...extra });
  if (![clinicId, listId, itemId].every(positiveId) || !Number.isFinite(+checkedAt)) return result('unknown', 'invalid_scope');
  locationIds = [...new Set(locationIds.map(positiveId).filter(Boolean))];
  if (!locationIds.length) return result('unknown', 'google_profile_not_resolved');
  const replacements = { clinicId: Number(clinicId), listId: Number(listId), itemId: Number(itemId), locationIds };
  const query = (sql, extra = {}) => db.sequelize.query(sql, { replacements: { ...replacements, ...extra }, type: db.Sequelize.QueryTypes.SELECT });
  const [link] = await query(`SELECT e.id,e.occurred_at,i.name,i.paciente_id,p.nombre,p.apellidos
    FROM MarketingPatientContactEvents e JOIN MarketingPatientListItems i ON i.id=e.item_id AND i.list_id=e.list_id
    JOIN MarketingPatientLists l ON l.id=e.list_id LEFT JOIN Pacientes p ON p.id_paciente=i.paciente_id
    WHERE e.list_id=:listId AND e.item_id=:itemId AND COALESCE(i.clinica_id,l.clinica_id)=:clinicId
      AND e.event_type='review_rating_followup_sent' AND e.channel='whatsapp'
      AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.kind'))='review_google_link_followup'
      AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.status'))='sent'
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.test_send')),'false') NOT IN ('true','1')
      AND NOT EXISTS (SELECT 1 FROM MarketingPatientContactEvents t WHERE t.list_id=i.list_id AND t.item_id=i.id
        AND t.event_type IN ('mass_campaign_test_sent','mass_campaign_test_failed'))
    ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1`);
  if (!link || !link.occurred_at || !Number.isFinite(+new Date(link.occurred_at))) return result('unknown', 'no_confirmed_google_link');
  const receipts = await query(`SELECT e.payload FROM MarketingPatientContactEvents e
    JOIN MarketingPatientListItems i ON i.id=e.item_id AND i.list_id=e.list_id JOIN MarketingPatientLists l ON l.id=e.list_id
    WHERE COALESCE(i.clinica_id,l.clinica_id)=:clinicId AND e.event_type='google_review_matched'
      AND ((e.list_id=:listId AND e.item_id=:itemId) OR (:patientId IS NOT NULL AND e.paciente_id=:patientId))
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.business_location_id')) AS UNSIGNED) IN (:locationIds)
      AND NOT EXISTS (SELECT 1 FROM MarketingPatientContactEvents t WHERE t.list_id=i.list_id AND t.item_id=i.id
        AND t.event_type IN ('mass_campaign_test_sent','mass_campaign_test_failed')) LIMIT 101`, { patientId: positiveId(link.paciente_id) });
  if (receipts.length) return result('found', 'stored_match_receipt', { link_event_id: Number(link.id) });
  const locations = await query('SELECT id,raw_payload FROM ClinicBusinessLocations WHERE id IN (:locationIds) AND is_active=1');
  const fresh = locations.length === locationIds.length && locations.every(location => {
    const raw = object(location.raw_payload), at = new Date(raw.clinicaclick_reviews_complete_synced_at || 0);
    const count = Number(raw.clinicaclick_reviews_complete_count);
    return raw.clinicaclick_reviews_complete_synced_at && Number.isFinite(+at) && checkedAt >= at
      && checkedAt - at <= 2 * 60 * 60 * 1000 && at >= new Date(link.occurred_at)
      && raw.clinicaclick_reviews_complete_count != null && raw.clinicaclick_reviews_complete_count !== ''
      && Number.isInteger(count) && count >= 0;
  });
  const reviews = await query(`SELECT id,reviewer_name,star_rating,matched_paciente_id,match_confidence FROM BusinessProfileReviews
    WHERE business_location_id IN (:locationIds) AND google_missing_at IS NULL
      AND ((create_time >= :since AND create_time <= :now) OR (:patientId IS NOT NULL AND matched_paciente_id=:patientId))
    ORDER BY create_time DESC,id DESC LIMIT 1001`, {
    since: new Date(+new Date(link.occurred_at) - 15 * 60 * 1000), now: checkedAt, patientId: positiveId(link.paciente_id),
  });
  if (reviews.length > 1000) return result('unknown', 'local_candidate_limit');
  let ambiguous = false;
  for (const review of reviews) {
    if (positiveId(link.paciente_id) && Number(review.matched_paciente_id) === Number(link.paciente_id)) {
      return result('found', 'stored_patient_match', { review_id: Number(review.id), link_event_id: Number(link.id) });
    }
    if (review.matched_paciente_id) continue;
    const score = Math.max(scoreNameMatch(review.reviewer_name, link.name),
      scoreNameMatch(review.reviewer_name, [link.nombre,link.apellidos].filter(Boolean).join(' ')));
    if (score >= 0.8) return result('found', 'compatible_name_after_link', { review_id: Number(review.id), confidence: score, link_event_id: Number(link.id) });
    if (score >= 0.5) ambiguous = true;
  }
  if (ambiguous) return result('unknown', 'ambiguous_name_match');
  if (!fresh) return result('unknown', 'complete_observation_not_recent');
  return result('not_detected', 'no_match_in_recent_complete_observation', { link_event_id: Number(link.id) });
}

module.exports = { checkStoredPublication };
