'use strict';

const { normalizePhoneDigits } = require('../lib/phone');
const { readReviewRequestHistory } = require('../lib/review-request-history');
const { reportRange } = require('./reviewActivityReport.service');
const { LAST_ATTENDED_DATE_KEYS, parseMarketingDate } = require('../lib/marketing-template-variables');
const positiveIds = values => [...new Set((values || []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
const phoneKey = value => normalizePhoneDigits(value);
const validMobile = value => /^34/.test(value) ? /^34[67]\d{8}$/.test(value) : /^[1-9]\d{7,14}$/.test(value);
const isReview = `l.objective_id='mass_sends' AND (JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.review_request')) IN ('true','1')
  OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.template_usage'))='solicitud_resena')`;
const testExclusion = `NOT EXISTS (SELECT 1 FROM MarketingPatientContactEvents te WHERE te.list_id=i.list_id AND te.item_id=i.id
  AND te.event_type IN ('mass_campaign_test_sent','mass_campaign_test_failed'))`;

function queueSummary(rows) {
  const counts = rows.reduce((s, row) => {
    const n = key => Math.max(0, Number(row[key]) || 0);
    return { total: s.total + n('total'), processed: s.processed + n('processed'),
      sent: s.sent + Math.max(0, n('processed') - n('failed')), pending: s.pending + n('pending'), failed: s.failed + n('failed') };
  }, { total: 0, processed: 0, sent: 0, pending: 0, failed: 0 });
  return { ...counts, percent: counts.total ? Math.min(100, Math.round(counts.processed / counts.total * 100)) : 0 };
}

function queuePage(rows, { group = false, view = 'active', limit = 5, offset = 0 } = {}) {
  if (!['active', 'inactive'].includes(view)) throw Object.assign(Error('Vista de colas inválida'), { status: 400 });
  if (group) view = 'active';
  limit = Math.min(25, Math.max(1, Number.parseInt(limit, 10) || 5));
  offset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const unique = [...new Map(rows.map(row => [row.id, row])).values()];
  const active = unique.filter(row => row.status_group === 'active' && (!group || row.started));
  const inactive = group ? [] : unique.filter(row => row.status_group !== 'active');
  const selected = view === 'active' ? active : inactive;
  const items = selected.slice(offset, offset + limit).map(row => ({ ...row,
    progress_percent: queueSummary([row]).percent,
    sent_count: Math.max(0, Number(row.processed || 0) - Number(row.failed || 0)),
    preview_body: reviewPreview(row),
  }));
  return { items, total: selected.length, counts: { active: active.length, inactive: inactive.length },
    summary: queueSummary(selected), view, limit, offset };
}

function reviewPreview(row) {
  const clinic = row.review_display_name || row.clinic_name || '[clínica]', sender = row.review_sender_name || '[remitente]';
  const body = String(row.message_preview || ''), senderFirst = /soy\s*\{\{\s*2\s*\}\}\s+de\s+\{\{\s*3\s*\}\}/i.test(body);
  return body.replace(/\{\{\s*(nombre|nombre_paciente|nombrepaciente|1)\s*\}\}/gi, '[nombre]')
    .replace(/\{\{\s*2\s*\}\}/g, senderFirst ? sender : clinic).replace(/\{\{\s*3\s*\}\}/g, senderFirst ? clinic : sender)
    .replace(/\{\{\s*(clinica|nombre_clinica|nombreclinica)\s*\}\}/gi, clinic)
    .replace(/\{\{\s*(firma_resenas|nombre_remitente_resenas|remitente_resena|review_sender_name)\s*\}\}/gi, sender)
    .replace(/\{\{\s*(fecha_ultima_cita_asistida|ultima_cita_asistida|last_attended_appointment_date|fecha|4)\s*\}\}/gi, '[fecha de visita]');
}

function countPotential(patients, history, queued = [], optOuts = [], now = new Date()) {
  const queuedPatients = new Set(queued.map(r => Number(r.paciente_id)).filter(Boolean));
  const queuedPhones = new Set(queued.map(r => phoneKey(r.phone)).filter(Boolean));
  const optedPatients = new Set(optOuts.map(r => Number(r.paciente_id)).filter(Boolean));
  const optedPhones = new Set(optOuts.map(r => phoneKey(r.phone_digits || r.phone)).filter(Boolean));
  const contacts = new Set();
  for (const patient of patients) {
    const id = Number(patient.id_paciente), phone = phoneKey(patient.telefono_movil);
    let fields = patient.date_fields || {};
    try { if (typeof fields === 'string') fields = JSON.parse(fields); } catch { fields = {}; }
    const importedCare = LAST_ATTENDED_DATE_KEYS.some(key => { const at = parseMarketingDate(fields?.[key]); return at && at <= now; });
    if (!validMobile(phone) || !(Number(patient.has_care) === 1 || importedCare) || history.patientIds.has(id) || history.phoneKeys.has(phone)
      || queuedPatients.has(id) || queuedPhones.has(phone) || optedPatients.has(id) || optedPhones.has(phone)) continue;
    contacts.add(phone);
  }
  return contacts.size;
}

function createService({ db, resolveProfile, queues, ratingSummary, automation, now = () => new Date() }) {
  const query = (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
  async function potentialByClinic(clinicIds) {
    const [patients, queued, optOuts, histories] = await Promise.all([
      query(`WITH memberships AS (
        SELECT id_paciente,clinica_id FROM Pacientes WHERE clinica_id IN (:clinicIds) AND fecha_baja IS NULL
        UNION SELECT p.id_paciente,pc.clinica_id FROM PacienteClinicas pc JOIN Pacientes p ON p.id_paciente=pc.paciente_id
          WHERE pc.clinica_id IN (:clinicIds) AND p.fecha_baja IS NULL
      ) SELECT p.id_paciente,m.clinica_id,p.telefono_movil,
        EXISTS(SELECT 1 FROM CitasPacientes a WHERE a.paciente_id=p.id_paciente AND a.clinica_id=m.clinica_id
          AND a.estado IN ('ha_acudido','en_atencion','completada') AND a.inicio<=UTC_TIMESTAMP()) has_care,
        (SELECT JSON_OBJECTAGG(f.field_key,f.value) FROM PatientCustomFields f WHERE f.paciente_id=p.id_paciente AND f.clinica_id=m.clinica_id
          AND f.field_key IN ('fecha_ultima_cita_asistida','ultima_cita_asistida','last_attended_appointment_date',
            'last_attended_visit_date','fecha_ultima_cita','fecha_ultimo_tratamiento','fecha_tratamiento')) date_fields
        FROM memberships m JOIN Pacientes p ON p.id_paciente=m.id_paciente`, { clinicIds }),
      query(`SELECT DISTINCT COALESCE(i.clinica_id,l.clinica_id) clinica_id,i.paciente_id,i.phone
        FROM MarketingPatientListItems i JOIN MarketingPatientLists l ON l.id=i.list_id
        WHERE COALESCE(i.clinica_id,l.clinica_id) IN (:clinicIds) AND l.status IN ('ready','scheduled','sending','paused')
          AND i.selected=1 AND i.status='ready' AND i.sent_at IS NULL AND (i.dispatch_status IS NULL OR i.dispatch_status IN ('pending','queued','sending','accepted','held_quality'))`, { clinicIds }),
      query(`SELECT clinica_id,paciente_id,phone_digits FROM MarketingContactOptOuts
        WHERE clinica_id IN (:clinicIds) AND status='active' AND channel='whatsapp'`, { clinicIds }),
      readReviewRequestHistory({ query, clinicIds, byClinic: true }),
    ]);
    // Reuse the send path's actual history contract, including coexistence,
    // frozen/paused queues and isolation of test deliveries. No recipient limit.
    const result = [];
    for (const clinicId of clinicIds) {
      const history = histories.get(clinicId);
      result.push({ clinic_id: clinicId, count: countPotential(patients.filter(r => Number(r.clinica_id) === clinicId), history,
        queued.filter(r => Number(r.clinica_id) === clinicId), optOuts.filter(r => Number(r.clinica_id) === clinicId), now()) });
    }
    return result;
  }

  async function overview(scope, { userId, scopeRaw, period = '30d' } = {}) {
    const clinicIds = positiveIds(scope.clinicIds);
    if (!clinicIds.length) throw Object.assign(Error('Selecciona una clínica o grupo'), { status: 400 });
    const range = reportRange(period, now());
    const clinics = await db.Clinica.findAll({ where: { id_clinica: clinicIds }, raw: true,
      attributes: ['id_clinica', 'nombre_clinica', 'configuracion', 'url_ficha_local', 'grupoClinicaId'] });
    const profiles = await Promise.all(clinics.map(async clinic => {
      const profile = await resolveProfile(clinic);
      return { clinic_id: Number(clinic.id_clinica), clinic_name: clinic.nombre_clinica,
        location_name: profile?.links?.review_profile_alias_location_name || profile?.links?.location_name || clinic.nombre_clinica,
        business_location_id: Number(profile?.location?.id || profile?.links?.business_location_id) || null,
        profile_url: profile?.links?.url_perfil_google || null, review_url: profile?.links?.url_dejar_resena || null };
    }));
    const locationIds = positiveIds(profiles.map(r => r.business_location_id));
    const [potentials, queueRows, ratingRows, counts, auto] = await Promise.all([
      potentialByClinic(clinicIds), queues({ userId, scopeRaw, includeHistory: true }),
      locationIds.length ? query(`WITH ranked AS (SELECT r.*,ROW_NUMBER() OVER (
        PARTITION BY business_location_id,BINARY SUBSTRING_INDEX(review_name,'/reviews/',-1)
        ORDER BY google_missing_at IS NULL DESC,last_seen_at DESC,id DESC) rank_id
        FROM BusinessProfileReviews r WHERE business_location_id IN (:locationIds))
        SELECT business_location_id,COUNT(*) total_reviews,SUM(CAST(star_rating AS UNSIGNED)) rating_sum,
        SUM(CAST(star_rating AS UNSIGNED)=5) five_star_reviews,MAX(last_seen_at) last_seen_at
        FROM ranked WHERE rank_id=1 AND google_missing_at IS NULL AND CAST(star_rating AS UNSIGNED) BETWEEN 1 AND 5
        GROUP BY business_location_id`, { locationIds }) : [],
      query(`SELECT COUNT(*) requests_sent FROM MarketingPatientListItems i JOIN MarketingPatientLists l ON l.id=i.list_id
        WHERE COALESCE(i.clinica_id,l.clinica_id) IN (:clinicIds) AND ${isReview} AND i.sent_at IS NOT NULL AND ${testExclusion}`, { clinicIds }),
      scope.scope === 'clinic' ? automation(scope) : null,
    ]);
    const [attributed, optOuts, ratings] = await Promise.all([
      require('./googleReviewHistory.service').countHistoricalMatches(db, clinicIds),
      query(`SELECT COUNT(DISTINCT CONCAT(clinica_id,':',phone_digits)) total FROM MarketingContactOptOuts
        WHERE clinica_id IN (:clinicIds) AND status='active' AND channel='whatsapp'`, { clinicIds }),
      privateRatings(scope, { period, summaryOnly: true }),
    ]);
    const googleProfiles = profiles.map(row => {
      const score = ratingRows.find(r => Number(r.business_location_id) === row.business_location_id);
      const shared = profiles.filter(p => p.business_location_id && p.business_location_id === row.business_location_id);
      return { ...row, rating: score ? ratingSummary(score) : null, last_seen_at: score?.last_seen_at || null,
        shared_with: shared.length > 1 ? shared.map(p => p.clinic_name) : [] };
    });
    const sent = Number(counts[0]?.requests_sent || 0);
    const queueReport = queuePage(queueRows, { group: scope.scope === 'group' });
    return { success: true, generated_at: now().toISOString(), scope: { type: scope.scope, group_id: scope.groupId || null,
      name: scope.group?.nombre_grupo || scope.group?.nombre || (clinics.length === 1 ? clinics[0].nombre_clinica : 'Grupo de clínicas'), clinic_count: clinics.length },
      potential_patients: { total: potentials.reduce((s, r) => s + r.count, 0), by_clinic: potentials, excludes_queued: true },
      google_profiles: googleProfiles, queues: queueReport.items, queue_summary: queueReport.summary, queue_page: queueReport,
      current: { queued: queueSummary(queueRows.filter(row => ['active','paused'].includes(row.status_group))).pending, opt_outs: Number(optOuts[0]?.total || 0) },
      ratings_in_period: ratings.total, private_ratings_summary: ratings.summary, period: range.period,
      historical: { requests_sent: sent, attributed_reviews: attributed, conversion: sent ? attributed / sent * 100 : null },
      automation: auto, provider_requests: 0 };
  }

  async function privateRatings(scope, options = {}) {
    const clinicIds = positiveIds(scope.clinicIds), range = options.period === 'all' ? null : reportRange(options.period || '30d', now());
    if (!clinicIds.length) return { success: true, items: [], total: 0, limit: 10, offset: 0 };
    const limit = Math.min(50, Math.max(1, Number.parseInt(options.limit, 10) || 10)), offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const rating = Number(options.rating), sortColumns = { clinic: 'clinic_name', patient: 'patient_name', rating: 'rating', date: 'occurred_at' };
    const sort = sortColumns[options.sort_by] || 'occurred_at', direction = options.sort_direction === 'asc' ? 'ASC' : 'DESC';
    const cte = `WITH ranked AS (SELECT e.id,e.list_id,e.item_id,e.occurred_at,e.payload,
      COALESCE(i.clinica_id,l.clinica_id) clinic_id,cl.nombre_clinica clinic_name,
      COALESCE(NULLIF(i.name,''),CONCAT_WS(' ',p.nombre,p.apellidos),'Paciente') patient_name,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.rating')) AS UNSIGNED) rating,
      ROW_NUMBER() OVER(PARTITION BY COALESCE(i.clinica_id,l.clinica_id),COALESCE(CONCAT('p:',i.paciente_id),CONCAT('ph:',i.phone),CONCAT('i:',i.id))
        ORDER BY e.occurred_at DESC,e.id DESC) rn
      FROM MarketingPatientContactEvents e JOIN MarketingPatientListItems i ON i.id=e.item_id AND i.list_id=e.list_id
      JOIN MarketingPatientLists l ON l.id=e.list_id JOIN Clinicas cl ON cl.id_clinica=COALESCE(i.clinica_id,l.clinica_id)
      LEFT JOIN Pacientes p ON p.id_paciente=i.paciente_id
      WHERE COALESCE(i.clinica_id,l.clinica_id) IN (:clinicIds) AND ${isReview} AND ${testExclusion}
        AND e.event_type IN ('review_rating_received','review_request_rating')
        ${range ? 'AND e.occurred_at >= :start AND e.occurred_at < :end' : ''}
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.rating')) AS UNSIGNED) BETWEEN 1 AND 5)
      SELECT * FROM ranked WHERE rn=1 ${rating >= 1 && rating <= 5 ? 'AND rating = :rating' : ''}`;
    const values = { clinicIds, start: range?.start, end: range?.end, rating, limit, offset };
    const [totals, rows] = await Promise.all([
      query(`SELECT COUNT(*) total,COALESCE(SUM(rating),0) rating_sum,${[1,2,3,4,5].map(n => `COALESCE(SUM(rating=${n}),0) r${n}`).join(',')}
        FROM (${cte}) counted`, values),
      (options.summaryOnly === true || options.summary_only === '1') ? [] : query(`SELECT r.*,(SELECT JSON_UNQUOTE(JSON_EXTRACT(f.payload,'$.content')) FROM MarketingPatientContactEvents f
        WHERE f.list_id=r.list_id AND f.item_id=r.item_id AND f.event_type='review_private_feedback_received'
        ORDER BY f.occurred_at DESC LIMIT 1) comment FROM (${cte}) r
        ORDER BY ${sort} ${direction},id DESC LIMIT :limit OFFSET :offset`, values),
    ]);
    const total = Number(totals[0]?.total || 0);
    return { success: true, items: rows.map(({ payload, rn, ...r }) => ({ ...r, rating: Number(r.rating) })), total, limit, offset,
      summary: { total, average: total ? Number(totals[0]?.rating_sum || 0) / total : null,
        distribution: [5,4,3,2,1].map(rating => ({ rating, count: Number(totals[0]?.['r'+rating] || 0),
          percent: total ? Number(totals[0]?.['r'+rating] || 0) / total * 100 : 0 })) } };
  }
  async function queueReport(scope, { userId, scopeRaw, ...options }) {
    return { success: true, ...queuePage(await queues({ userId, scopeRaw, includeHistory: true }), { ...options, group: scope.scope === 'group' }) };
  }
  return { overview, privateRatings, potentialByClinic, queueReport };
}

function current() {
  const db = require('../../models'), bulk = require('./marketingBulkSends.service');
  return createService({ db, resolveProfile: require('./googleLocalLinks.service').resolveClinicGoogleReviewProfile,
    queues: require('./sendQueues.service').listReviewQueues, ratingSummary: bulk.buildGoogleRatingSummary,
    automation: scope => bulk.getReviewRequestAutomationStatus(scope) });
}
module.exports = { createService, current, countPotential, positiveIds, queueSummary, queuePage, reviewPreview };
