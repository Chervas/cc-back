'use strict';

const { cpl } = require('./campaignWorkspaceReport.service');

const INDICATORS = [
  ['no-leads', 'Campañas sin nuevos leads', 'user-group', 'Dos últimos días completos'],
  ['cost', 'Coste por lead', 'banknotes', 'Periodo seleccionado frente al anterior'],
  ['delivery', 'Anuncios que no se publican', 'megaphone', 'Último estado sincronizado'],
  ['reception', 'Conexiones y recepción', 'link', 'Última comprobación del destino'],
  ['privacy', 'Privacidad y consentimiento', 'shield-check', 'Comprobación firmada de la web'],
  ['signals', 'Señales a Google y Meta', 'arrow-path', 'Últimos registros de entrega'],
];
const money = (value, currency) => new Intl.NumberFormat('es-ES', {
  ...(currency ? { style: 'currency', currency } : {}), maximumFractionDigits: 2,
}).format(value);

function buildWorkspaceHealth(report, evidence = new Map(), now = new Date()) {
  const findings = [];
  const coverage = new Map(INDICATORS.map(([id]) => [id, { evaluated: new Set(), total: new Set(), checks: [] }]));
  const add = (row, category, title, detail, nextStep, key, severity = 'warning') => {
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
    });
  };
  for (const row of report.rows) {
    const observed = evidence.get(row.campaign.id) || {};
    const fresh = row.coverage.updatedAt && new Date(now) - new Date(row.coverage.updatedAt) < 36 * 3600000
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
    if (eligible && ['stable', 'attention'].includes(row.performance)) {
      coverage.get('cost').evaluated.add(row.campaign.id);
      if (row.performance === 'attention') add(row, 'cost', 'Ha subido el coste por lead',
        `${money(cpl(row.current), row.campaign.currency)} por interesado frente a ${money(cpl(row.previous), row.campaign.currency)} en el periodo anterior.`,
        'Compara los anuncios y los destinos antes de ajustar la campaña. No se modifica nada automáticamente.');
    }
    const freshAds = row.ads.filter(ad => ad.lastSeenAt && new Date(now) - new Date(ad.lastSeenAt) < 36 * 3600000);
    if (eligible && row.ads.length && freshAds.length === row.ads.length) {
      coverage.get('delivery').evaluated.add(row.campaign.id);
      const rejected = freshAds.filter(ad => ad.rejected);
      if (rejected.length) add(row, 'delivery', `${rejected.length} anuncios rechazados`, rejected.map(ad => ad.title).join(', '),
        'Consulta el motivo en la plataforma y corrige el anuncio o solicita una revisión.', null, 'critical');
    }
    if (!row.campaign.assigned) add(row, 'reception', 'Falta asignar la campaña a una clínica',
      'La cuenta es compartida. Sus leads y resultados no se han atribuido a ninguna sede.',
      'Confirma a qué clínica pertenece la campaña.', null, 'critical');
    if (observed.reception?.checked) {
      coverage.get('reception').evaluated.add(row.campaign.id);
      row.receptionReady = observed.reception.ready === true && row.campaign.assigned;
      if (!observed.reception.ready) add(row, 'reception', observed.reception.title || 'Revisa la recepción de interesados',
        observed.reception.detail, 'Completa la preparación del destino y vuelve a comprobarlo.', observed.reception.key, 'critical');
    }
    if (observed.privacy?.checked && row.campaign.destination !== 'native') {
      coverage.get('privacy').evaluated.add(row.campaign.id);
      if (!observed.privacy.ready) add(row, 'privacy', 'Falta comprobar el consentimiento de la web',
        observed.privacy.detail, 'Revisa el aviso de privacidad y ejecuta una nueva comprobación.', observed.privacy.key);
    }
    if (observed.signals?.checked) {
      coverage.get('signals').evaluated.add(row.campaign.id);
      if (!observed.signals.ready) add(row, 'signals', 'Hay señales pendientes de entrega', observed.signals.detail,
        'Revisa los registros de entrega antes de cambiar las conversiones.', observed.signals.key);
    }
  }
  findings.sort((a, b) => Number(b.technical) - Number(a.technical) || Number(a.severity !== 'critical') - Number(b.severity !== 'critical'));
  const blocks = INDICATORS.map(([id, title, icon, window]) => {
    const { evaluated, total } = coverage.get(id);
    const issues = findings.filter(finding => finding.category === id);
    const campaignIds = [...new Set(issues.flatMap(finding => finding.campaignIds))];
    const missing = total.size - evaluated.size;
    return {
      id, title, icon, window, findings: issues, campaignIds,
      tone: issues.length ? issues.some(issue => issue.severity === 'critical') ? 'critical' : 'warning'
        : !total.size || missing ? 'neutral' : 'good',
      status: issues.length ? `${campaignIds.length} ${campaignIds.length === 1 ? 'campaña afectada' : 'campañas afectadas'}`
        : !total.size ? 'No aplica' : !evaluated.size ? 'Sin comprobar' : missing ? 'Datos parciales' : 'OK',
      summary: issues[0]?.title || (!total.size ? 'No hay campañas aplicables a este indicador.'
        : missing ? `Faltan comprobaciones actuales de ${missing} ${missing === 1 ? 'campaña' : 'campañas'}.` : 'Sin incidencias en las campañas comprobadas.'),
      coverage: `Comprobadas: ${evaluated.size} de ${total.size} campañas`,
      checks: [{ label: 'Cobertura', value: `${evaluated.size} de ${total.size}`, tone: missing ? 'neutral' : 'good' }],
    };
  });
  return { ...report, findings, healthBlocks: blocks, technicalCount: findings.filter(finding => finding.technical).length,
    performanceCount: findings.filter(finding => !finding.technical).length,
    insufficientCount: report.rows.filter(row => row.performance === 'insufficient').length,
    affectedCount: new Set(findings.flatMap(finding => finding.campaignIds)).size };
}

module.exports = { buildWorkspaceHealth };
