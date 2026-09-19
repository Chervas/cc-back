'use strict';

const { cpl, freshObservation } = require('./campaignWorkspaceReport.service');

const INDICATORS = [
  ['no-leads', 'Campañas sin nuevos leads', 'user-group', 'Dos últimos días completos'],
  ['cost', 'Coste por lead', 'banknotes', 'Periodo seleccionado frente al anterior'],
  ['delivery', 'Anuncios que no se publican', 'megaphone', 'Último estado sincronizado'],
  ['reception', 'Conexiones y recepción', 'link', 'Última comprobación del destino'],
  ['privacy', 'Privacidad y consentimiento', 'shield-check', 'Comprobación firmada de la web'],
  ['signals', 'Señales a Google y Meta', 'arrow-path', 'Entregas de las últimas 24 horas'],
];
const money = (value, currency) => new Intl.NumberFormat('es-ES', {
  ...(currency ? { style: 'currency', currency } : {}), maximumFractionDigits: 2,
}).format(value);
const inactiveAdStates = new Set(['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED',
  'PENDING_REVIEW', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_BILLING_INFO', 'PREAPPROVED', 'PENDING', 'NOT_ELIGIBLE']);
const deliveryState = ad => ad.rejected ? 'rejected' : /^(ACTIVE|ENABLED)$/i.test(ad.status || '') ? 'active'
  : ad.status === 'LIMITED' ? 'limited' : inactiveAdStates.has(ad.status) ? 'inactive' : null;

function buildWorkspaceHealth(report, evidence = new Map(), now = new Date()) {
  const findings = [];
  const coverage = new Map(INDICATORS.map(([id]) => [id, { evaluated: new Set(), total: new Set(), pending: new Set(), checks: [] }]));
  const add = (row, category, title, detail, nextStep, key, severity = 'warning', extra = {}) => {
    const id = `${category}:${key || row.campaign.id}`;
    const existing = findings.find(finding => finding.id === id);
    if (existing) {
      if (!existing.campaignIds.includes(row.campaign.id)) existing.campaignIds.push(row.campaign.id);
      return;
    }
    findings.push({ id, category, title, detail, nextStep, severity, campaign: row.campaign, campaignIds: [row.campaign.id],
      technical: ['reception', 'privacy', 'signals'].includes(category),
      window: INDICATORS.find(([key]) => key === category)[3],
      source: ['cost', 'no-leads'].includes(category) ? 'Inversión sincronizada y registros del CRM' : 'Comprobaciones persistidas',
      ...extra,
    });
  };
  for (const row of report.rows) {
    const observed = { ...(evidence.get(row.campaign.id) || {}) };
    // Historical receipts cannot override a newer failed or unfinished provider check, including web-only campaigns.
    if (row.campaign.provider === 'meta_ads' && row.campaign.destinationCheck?.status) {
      const denied = row.campaign.destinationCheck.error === 'workspace_meta_permissions_required';
      observed.reception = { checked: true, ready: false, configured: false,
        state: denied ? 'action_required' : 'unverified', title: 'Revisa el acceso a Meta',
        detail: 'Meta ha rechazado el acceso. Los resultados guardados se conservan, pero la recepción necesita una nueva comprobación.',
        key: denied ? `meta-account:${row.campaign.account_id}` : row.campaign.id };
      row.receptionReady = false;
    }
    for (const pending of observed.optimization || []) add(row, pending.action === 'pause_underperforming_ads' ? 'delivery' : 'cost',
      'Hay un ajuste sin confirmar', `${pending.actionLabel}. Todavía no se ha confirmado el resultado en la plataforma.`,
      'Revisa el historial del ajuste. No se repetirá el envío; otros ajustes esperan esta revisión.', `optimization:${pending.id}`, 'warning',
      { technical: true, optimizationRunId: pending.id, source: 'Registro de ajustes de Optimiza', window: 'Última comprobación del ajuste' });
    const fresh = freshObservation(row.coverage.updatedAt, now)
      && row.coverage.latestMetricDate === report.period.end;
    const eligible = !row.campaign.paused && row.campaign.assigned;
    for (const [id] of INDICATORS) {
      if (['cost', 'no-leads', 'delivery'].includes(id) && !eligible) continue;
      if (id === 'privacy' && row.campaign.destination === 'native') continue;
      coverage.get(id).total.add(row.campaign.id);
    }
    if (eligible && fresh) {
      coverage.get('no-leads').evaluated.add(row.campaign.id);
      if (row.coverage.recentSpend > 0 && row.coverage.recentLeads === 0) add(row, 'no-leads',
        'Hay inversión sin nuevos leads', `${money(row.coverage.recentSpend, row.campaign.currency)} invertidos y ningún nuevo interesado atribuido en los dos últimos días completos.`,
        'Comprueba el formulario y la entrega de los anuncios. La ausencia de leads no demuestra por sí sola un fallo técnico.');
    }
    if (eligible && fresh && ['stable', 'attention'].includes(row.performance)) {
      coverage.get('cost').evaluated.add(row.campaign.id);
      if (row.performance === 'attention') add(row, 'cost', 'Ha subido el coste por lead',
        `${money(cpl(row.current), row.campaign.currency)} por interesado frente a ${money(cpl(row.previous), row.campaign.currency)} en el periodo anterior.`,
        'Compara los anuncios y los destinos antes de ajustar la campaña. No se modifica nada automáticamente.');
    }
    const freshAds = row.ads.filter(ad => freshObservation(ad.lastSeenAt, now));
    if (eligible && /^(ACTIVE|ENABLED)$/i.test(row.campaign.status || '')) {
      const complete = row.ads.length && freshAds.length === row.ads.length && freshAds.every(ad => deliveryState(ad));
      if (complete) coverage.get('delivery').evaluated.add(row.campaign.id);
      // A fresh rejection remains an incident even when the rest of the inventory is not yet verified.
      const rejected = freshAds.filter(ad => ad.rejected);
      if (rejected.length) add(row, 'delivery', `${rejected.length} ${rejected.length === 1 ? 'anuncio rechazado' : 'anuncios rechazados'}`, rejected.map(ad => ad.title).join(', '),
        'Consulta el motivo en la plataforma y corrige el anuncio o solicita una revisión.', null, 'critical');
      else if (complete && !freshAds.some(ad => ['active', 'limited'].includes(deliveryState(ad)))) add(row, 'delivery',
        'Los anuncios sincronizados no están activos',
        `La campaña figura activa, pero ${freshAds.length === 1 ? 'su anuncio no está activo' : `sus ${freshAds.length} anuncios no están activos`} en la última sincronización.`,
        'Revisa los estados de los anuncios y sus grupos. Pueden estar en pausa, en revisión o pendientes de resolver una incidencia.');
      const limited = freshAds.filter(ad => deliveryState(ad) === 'limited');
      if (limited.length) add(row, 'delivery', 'Hay anuncios con publicación limitada',
        limited.map(ad => ad.title).join(', '),
        'Google permite publicar estos anuncios con limitaciones. Consulta los motivos antes de modificar su contenido.',
        `limited:${row.campaign.id}`);
    }
    if (!row.campaign.assigned) add(row, 'reception', 'Falta asignar la campaña a una clínica',
      'La cuenta es compartida. Sus leads y resultados no se han atribuido a ninguna sede.',
      'Confirma a qué clínica pertenece la campaña.', null, 'critical');
    if (observed.reception?.checked && observed.reception.state !== 'unverified') {
      coverage.get('reception').evaluated.add(row.campaign.id);
      row.receptionReady = observed.reception.ready === true && row.campaign.assigned;
      if (observed.reception.state === 'pending_confirmation') coverage.get('reception').pending.add(row.campaign.id);
      else if (!observed.reception.ready) add(row, 'reception', observed.reception.title || 'Revisa la recepción de interesados',
        observed.reception.detail, 'Completa la preparación del destino y vuelve a comprobarlo.', observed.reception.key, 'critical');
    }
    if (observed.privacy?.checked && row.campaign.destination !== 'native') {
      coverage.get('privacy').evaluated.add(row.campaign.id);
      if (!observed.privacy.ready) add(row, 'privacy', 'Falta comprobar el consentimiento de la web',
        observed.privacy.detail, 'Revisa el aviso de privacidad y ejecuta una nueva comprobación.', observed.privacy.key);
    }
    if (observed.signals?.checked) {
      coverage.get('signals').evaluated.add(row.campaign.id);
      if (Number.isSafeInteger(observed.signals.received)) {
        coverage.get('signals').checks.push({ provider: row.campaign.provider, received: observed.signals.received,
          processed: observed.signals.processed || 0, processing: observed.signals.processing || 0,
          pending: observed.signals.pending || 0, warnings: observed.signals.warnings || 0 });
      }
      if (!observed.signals.ready) add(row, 'signals', 'Hay señales pendientes de entrega', observed.signals.detail,
        'Revisa los registros de entrega antes de cambiar las conversiones.', observed.signals.key);
    }
  }
  findings.sort((a, b) => Number(b.technical) - Number(a.technical) || Number(a.severity !== 'critical') - Number(b.severity !== 'critical'));
  const blocks = INDICATORS.map(([id, title, icon, window]) => {
    const { evaluated, total, pending, checks } = coverage.get(id);
    const issues = findings.filter(finding => finding.category === id);
    const campaignIds = [...new Set(issues.flatMap(finding => finding.campaignIds))];
    const missing = total.size - evaluated.size;
    return {
      id, title, icon, window, findings: issues, campaignIds,
      tone: issues.length ? issues.some(issue => issue.severity === 'critical') ? 'critical' : 'warning'
        : !total.size || missing || pending.size ? 'neutral' : 'good',
      status: issues.length ? `${campaignIds.length} ${campaignIds.length === 1 ? 'campaña afectada' : 'campañas afectadas'}`
        : !total.size ? 'No aplica' : !evaluated.size ? id === 'cost' ? 'Sin comparativa' : 'Sin comprobar' : missing ? 'Datos parciales' : pending.size ? 'Pendiente de recepción' : 'OK',
      summary: issues[0]?.title || (!total.size ? 'No hay campañas aplicables a este indicador.'
        : missing ? id === 'cost' ? 'Faltan datos suficientes para comparar con el periodo anterior.'
          : `Faltan comprobaciones actuales de ${missing} ${missing === 1 ? 'campaña' : 'campañas'}.`
          : pending.size ? 'Configuración preparada, aún sin recepción reciente en todos los destinos.' : 'Sin incidencias en las campañas comprobadas.'),
      coverage: `Comprobadas: ${evaluated.size} de ${total.size} campañas`,
      checks: [{ label: 'Cobertura', value: `${evaluated.size} de ${total.size}`, tone: missing || !total.size ? 'neutral' : 'good' },
        ...(pending.size ? [{ label: 'Pendientes de recibir', value: String(pending.size), tone: 'neutral' }] : []),
        ...(id === 'signals' && checks.length ? [
          ...[['meta_ads', 'Meta'], ['google_ads', 'Google']].filter(([provider]) => checks.some(row => row.provider === provider))
            .map(([provider, label]) => ({ label: `Recibidos por ${label}`,
              value: String(checks.filter(row => row.provider === provider).reduce((sum, row) => sum + row.received, 0)), tone: 'neutral' })),
          ...(checks.some(row => row.provider === 'google_ads') ? [
            { label: 'Procesados sin avisos por Google', value: String(checks.reduce((sum, row) => sum + row.processed, 0)), tone: 'neutral' },
            { label: 'Procesando en Google', value: String(checks.reduce((sum, row) => sum + row.processing, 0)), tone: checks.some(row => row.processing) ? 'warning' : 'neutral' },
          ] : []),
          { label: 'Con avisos', value: String(checks.reduce((sum, row) => sum + row.warnings, 0)), tone: checks.some(row => row.warnings) ? 'warning' : 'neutral' },
          { label: 'Sin confirmar', value: String(checks.reduce((sum, row) => sum + row.pending, 0)), tone: checks.some(row => row.pending) ? 'warning' : 'neutral' },
        ] : []),
      ],
    };
  });
  return { ...report, findings, healthBlocks: blocks, technicalCount: findings.filter(finding => finding.technical).length,
    performanceCount: findings.filter(finding => !finding.technical).length,
    insufficientCount: report.rows.filter(row => row.performance === 'insufficient').length,
    affectedCount: new Set(findings.flatMap(finding => finding.campaignIds)).size };
}

module.exports = { buildWorkspaceHealth };
