'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');

const {
  BusinessProfileReview,
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

function scoreNameMatch(reviewName, candidateName) {
  const review = normalizeName(reviewName);
  const candidate = normalizeName(candidateName);
  if (!review || !candidate) return 0;
  if (review === candidate) return 1;
  if (review.includes(candidate) || candidate.includes(review)) return 0.92;

  const reviewTokens = nameTokens(review);
  const candidateTokens = nameTokens(candidate);
  if (!reviewTokens.length || !candidateTokens.length) return 0;

  const candidateSet = new Set(candidateTokens);
  const matches = reviewTokens.filter((token) => candidateSet.has(token)).length;
  const denominator = Math.max(reviewTokens.length, candidateTokens.length);
  return denominator ? matches / denominator : 0;
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
      AND COALESCE(i.clinica_id, l.clinica_id) = :clinicId
      AND e.occurred_at >= DATE_SUB(:reviewTime, INTERVAL :windowHours HOUR)
      AND e.occurred_at <= DATE_ADD(:reviewTime, INTERVAL 15 MINUTE)
    ORDER BY e.occurred_at DESC
    LIMIT 100
    `,
    {
      replacements: {
        clinicId: Number(review.clinica_id),
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
