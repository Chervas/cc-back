'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');

const {
  BusinessProfileReview,
  Clinica,
  JobRequest,
  MarketingPatientContactEvent,
  sequelize,
} = db;

const JOB_TYPE = 'business_profile_review_match';
const MATCH_WINDOW_HOURS = 48;
const MIN_MATCH_SCORE = 0.67;

const normalizeName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const nameTokens = (value) => normalizeName(value)
  .split(' ')
  .filter((token) => token.length > 1);

const allNameTokens = (value) => normalizeName(value)
  .split(' ')
  .filter(Boolean);

function compactName(value) {
  return allNameTokens(value).join('');
}

function initials(tokens) {
  return (tokens || []).map((token) => token[0] || '').join('');
}

function isOneEditAway(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return true;
  if (left.length < 5 || right.length < 5) return false;
  if (Math.abs(left.length - right.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (left.length - i) + (right.length - j) <= 1;
}

function scoreNameMatch(reviewName, candidateName) {
  const review = normalizeName(reviewName);
  const candidate = normalizeName(candidateName);
  if (!review || !candidate) return 0;
  if (review === candidate) return 1;
  if (review.includes(candidate) || candidate.includes(review)) return 0.92;

  const reviewAllTokens = allNameTokens(review);
  const candidateAllTokens = allNameTokens(candidate);
  const reviewCompact = compactName(review);
  const candidateCompact = compactName(candidate);
  if (reviewCompact.length >= 6 && candidateCompact.includes(reviewCompact)) return 0.92;
  if (candidateAllTokens.length >= 2 && reviewCompact === `${candidateAllTokens[0]}${candidateAllTokens[candidateAllTokens.length - 1]}`) {
    return 0.9;
  }

  const reviewInitials = initials(reviewAllTokens);
  const candidateInitials = initials(candidateAllTokens);
  if (reviewInitials.length >= 2 && reviewInitials === candidateInitials) return 0.9;
  if (
    reviewAllTokens.length === 2
    && candidateAllTokens.length >= 3
    && reviewAllTokens[0] === candidateAllTokens[0]
    && reviewAllTokens[1] === initials(candidateAllTokens.slice(1))
  ) {
    return 0.9;
  }

  const reviewTokens = nameTokens(review);
  const candidateTokens = nameTokens(candidate);
  if (!reviewTokens.length || !candidateTokens.length) return 0;

  const matches = reviewTokens.filter((token) => candidateTokens.some((candidateToken) => isOneEditAway(token, candidateToken))).length;
  if (matches >= 2 && reviewTokens.length >= 2 && candidateTokens.length >= 2) {
    return Math.max(0.67, matches / Math.max(reviewTokens.length, candidateTokens.length));
  }
  const denominator = Math.max(reviewTokens.length, candidateTokens.length);
  return denominator ? matches / denominator : 0;
}

function asPlainObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const parsed = Number(value || 0);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    const parsed = String(value || '').trim();
    if (parsed) return parsed;
  }
  return '';
}

function clinicUsesReviewAlias(configuracion, review) {
  const config = asPlainObject(configuracion);
  const reviews = asPlainObject(config.reviews || config.resenas || config.review_requests);
  const alias = asPlainObject(reviews.google_business_profile_alias || reviews.business_profile_alias);
  const aliasBusinessLocationId = firstPositiveInteger(
    alias.business_location_id,
    alias.businessLocationId,
    reviews.google_business_profile_alias_business_location_id,
    reviews.google_business_location_alias_business_location_id,
    config.review_google_business_profile_alias_business_location_id
  );
  const aliasLocationId = firstString(
    alias.location_id,
    alias.locationId,
    reviews.google_business_profile_alias_location_id,
    reviews.google_business_location_alias_location_id,
    config.review_google_business_profile_alias_location_id
  );
  const reviewBusinessLocationId = Number(review.business_location_id || 0);
  const reviewLocationId = firstString(review.location_id, review.locationId);
  return !!(
    aliasBusinessLocationId
    && reviewBusinessLocationId
    && aliasBusinessLocationId === reviewBusinessLocationId
  ) || !!(
    aliasLocationId
    && reviewLocationId
    && aliasLocationId === reviewLocationId
  );
}

async function resolveCandidateClinicIdsForReview(review) {
  const ids = new Set();
  const reviewClinicId = Number(review.clinica_id || 0);
  if (Number.isInteger(reviewClinicId) && reviewClinicId > 0) {
    ids.add(reviewClinicId);
  }

  if (!Clinica || (!review.business_location_id && !review.location_id)) {
    return Array.from(ids);
  }

  try {
    const clinics = await Clinica.findAll({
      attributes: ['id_clinica', 'configuracion'],
      raw: true,
    });
    for (const clinic of clinics || []) {
      if (clinicUsesReviewAlias(clinic.configuracion, review)) {
        const clinicId = Number(clinic.id_clinica || 0);
        if (Number.isInteger(clinicId) && clinicId > 0) {
          ids.add(clinicId);
        }
      }
    }
  } catch (error) {
    console.warn('[google-review-match] No se pudieron resolver alias de ficha para reseñas', {
      review_id: review.id,
      error: error?.message || error,
    });
  }

  return Array.from(ids);
}

async function enqueueBusinessProfileReviewMatch(reviewId, options = {}) {
  const id = Number(reviewId || 0);
  if (!Number.isInteger(id) || id <= 0 || !JobRequest) {
    return { queued: false, reason: 'invalid_review_id' };
  }

  const pending = await sequelize.query(
    `
    SELECT id
    FROM JobRequests
    WHERE type = :type
      AND status IN ('pending', 'queued', 'running', 'waiting')
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.review_id')) AS UNSIGNED) = :reviewId
    LIMIT 1
    `,
    { replacements: { type: JOB_TYPE, reviewId: id }, type: QueryTypes.SELECT }
  );

  if (pending.length) {
    return { queued: false, reason: 'already_queued', job_id: pending[0].id };
  }

  const job = await jobRequestsService.enqueueJobRequest({
    type: JOB_TYPE,
    priority: options.priority || 'low',
    origin: options.origin || 'business_profile_sync',
    payload: { review_id: id },
    maxAttempts: 3,
  });

  return { queued: true, job_id: job.id };
}

async function findBestReviewCandidate(review) {
  const reviewTime = review.create_time || review.update_time || review.created_at || new Date();
  const candidateClinicIds = await resolveCandidateClinicIdsForReview(review);
  if (!candidateClinicIds.length) {
    return null;
  }
  const rows = await sequelize.query(
    `
    SELECT
      e.id AS event_id,
      e.list_id,
      e.item_id,
      e.paciente_id AS event_paciente_id,
      e.occurred_at,
      i.paciente_id AS item_paciente_id,
      i.name AS item_name,
      i.phone AS item_phone,
      p.nombre AS paciente_nombre,
      p.apellidos AS paciente_apellidos
    FROM MarketingPatientContactEvents e
    INNER JOIN MarketingPatientLists l ON l.id = e.list_id
    LEFT JOIN MarketingPatientListItems i ON i.id = e.item_id
    LEFT JOIN Pacientes p ON p.id_paciente = COALESCE(e.paciente_id, i.paciente_id)
    WHERE e.event_type = 'review_rating_followup_sent'
      AND e.channel = 'whatsapp'
      AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.kind')) = 'review_google_link_followup'
      AND COALESCE(i.clinica_id, l.clinica_id) IN (:candidateClinicIds)
      AND e.occurred_at >= DATE_SUB(:reviewTime, INTERVAL :windowHours HOUR)
      AND e.occurred_at <= DATE_ADD(:reviewTime, INTERVAL 15 MINUTE)
    ORDER BY e.occurred_at DESC
    LIMIT 100
    `,
    {
      replacements: {
        candidateClinicIds,
        reviewTime,
        windowHours: MATCH_WINDOW_HOURS,
      },
      type: QueryTypes.SELECT,
    }
  );

  let best = null;
  for (const row of rows) {
    const patientName = [row.paciente_nombre, row.paciente_apellidos].filter(Boolean).join(' ').trim();
    const itemScore = scoreNameMatch(review.reviewer_name, row.item_name);
    const patientScore = scoreNameMatch(review.reviewer_name, patientName);
    const score = Math.max(itemScore, patientScore);
    if (!best || score > best.score) {
      best = { ...row, score, patientName };
    }
  }

  return best && best.score >= MIN_MATCH_SCORE ? best : null;
}

async function matchBusinessProfileReview(reviewId) {
  const id = Number(reviewId || 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('business_profile_review_match requires payload.review_id');
  }

  const review = await BusinessProfileReview.findByPk(id);
  if (!review) {
    return { skipped: true, reason: 'review_not_found', review_id: id };
  }

  if (review.matched_contact_event_id || review.matched_paciente_id) {
    return {
      skipped: true,
      reason: 'already_matched',
      review_id: id,
      matched_paciente_id: review.matched_paciente_id || null,
    };
  }

  if (!review.clinica_id || !review.reviewer_name) {
    return { skipped: true, reason: 'missing_review_identity', review_id: id };
  }

  const candidate = await findBestReviewCandidate(review);
  if (!candidate) {
    return { matched: false, reason: 'no_candidate', review_id: id };
  }

  const pacienteId = Number(candidate.event_paciente_id || candidate.item_paciente_id || 0) || null;
  const event = await MarketingPatientContactEvent.create({
    list_id: candidate.list_id,
    item_id: candidate.item_id || null,
    paciente_id: pacienteId,
    event_type: 'google_review_matched',
    channel: 'google',
    payload: {
      review_id: review.id,
      review_name: review.review_name,
      reviewer_name: review.reviewer_name,
      star_rating: review.star_rating,
      business_location_id: review.business_location_id,
      followup_event_id: candidate.event_id,
      confidence: Number(candidate.score.toFixed(3)),
      match_window_hours: MATCH_WINDOW_HOURS,
      matched_by: 'reviewer_name_after_google_link',
      review_create_time: review.create_time || null,
    },
    occurred_at: review.create_time || review.update_time || new Date(),
  });

  await review.update({
    matched_paciente_id: pacienteId,
    matched_contact_event_id: event.id,
    match_confidence: Number(candidate.score.toFixed(3)),
    match_reason: `Nombre compatible tras enlace Google enviado en las ${MATCH_WINDOW_HOURS}h previas`,
    matched_at: new Date(),
  });

  return {
    matched: true,
    review_id: review.id,
    event_id: event.id,
    paciente_id: pacienteId,
    confidence: Number(candidate.score.toFixed(3)),
  };
}

async function runBusinessProfileReviewMatchJob(payload = {}) {
  const result = await matchBusinessProfileReview(payload.review_id || payload.reviewId);
  return { status: 'completed', result };
}

module.exports = {
  JOB_TYPE,
  enqueueBusinessProfileReviewMatch,
  matchBusinessProfileReview,
  runBusinessProfileReviewMatchJob,
};
