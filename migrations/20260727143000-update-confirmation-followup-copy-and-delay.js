'use strict';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const CATALOG_BODY_BY_ID = {
  24: 'Lo primero pedirte disculpas por insistir 🙏 {{1}}. Sé que te he escrito muchas veces, pero es importante que dejemos cerrada la agenda médica con antelación.\n\n¿Me confirmas tu asistencia mañana?',
  25: 'Perdona por escribirte de nuevo {{1}} 😅, sé que acabamos de hablar, pero mandamos este mensaje para confirmar que el teléfono de contacto es correcto. ¿Nos confirmas tu cita si no es mucha molestia?🙏🙏',
  27: 'Lo primero pedirte disculpas por insistir 🙏 {{1}}. Sé que te he escrito muchas veces, pero es importante que dejemos cerrada la agenda médica con antelación.\n\n¿Me confirmas tu asistencia mañana?',
  86: 'Primer de tot, disculpa per insistir 🙏 {{1}}. Sé que t’he escrit moltes vegades, però és important que deixem tancada l’agenda mèdica amb antelació.\n\nEm confirmes la teva assistència demà?',
  87: 'First of all, sorry for insisting 🙏 {{1}}. I know I have written to you many times, but it is important that we finalize the medical schedule in advance.\n\nCould you confirm your attendance tomorrow?',
  88: 'Perdona per escriure’t de nou {{1}} 😅, sé que acabem de parlar, però enviem aquest missatge per confirmar que el telèfon de contacte és correcte. Ens confirmes la cita si no és molta molèstia?🙏🙏',
  89: 'Sorry to write to you again {{1}} 😅, I know we just spoke, but we send this message to confirm that the contact phone number is correct. Could you confirm your appointment if it is not too much trouble?🙏🙏',
  90: 'Primer de tot, disculpa per insistir 🙏 {{1}}. Sé que t’he escrit moltes vegades, però és important que deixem tancada l’agenda mèdica amb antelació.\n\nEm confirmes la teva assistència demà?',
  91: 'First of all, sorry for insisting 🙏 {{1}}. I know I have written to you many times, but it is important that we finalize the medical schedule in advance.\n\nCould you confirm your attendance tomorrow?',
};

const MANUAL_TEXT_BY_CATALOG_ID = {
  24: 'Lo primero pedirte disculpas por insistir 🙏 {{paciente.nombre}}. Sé que te he escrito muchas veces, pero es importante que dejemos cerrada la agenda médica con antelación.\n\n¿Me confirmas tu asistencia mañana?',
  25: 'Perdona por escribirte de nuevo {{paciente.nombre}} 😅, sé que acabamos de hablar, pero mandamos este mensaje para confirmar que el teléfono de contacto es correcto. ¿Nos confirmas tu cita si no es mucha molestia?🙏🙏',
  86: 'Primer de tot, disculpa per insistir 🙏 {{paciente.nombre}}. Sé que t’he escrit moltes vegades, però és important que deixem tancada l’agenda mèdica amb antelació.\n\nEm confirmes la teva assistència demà?',
  87: 'First of all, sorry for insisting 🙏 {{paciente.nombre}}. I know I have written to you many times, but it is important that we finalize the medical schedule in advance.\n\nCould you confirm your attendance tomorrow?',
  88: 'Perdona per escriure’t de nou {{paciente.nombre}} 😅, sé que acabem de parlar, però enviem aquest missatge per confirmar que el telèfon de contacte és correcte. Ens confirmes la cita si no és molta molèstia?🙏🙏',
  89: 'Sorry to write to you again {{paciente.nombre}} 😅, I know we just spoke, but we send this message to confirm that the contact phone number is correct. Could you confirm your appointment if it is not too much trouble?🙏🙏',
};

const FOLLOWUP_CATALOG_IDS = new Set([23, 24, 25, 27]);

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getCatalogIdFromConfig(config) {
  return toIntOrNull(config?.fallback_catalog_template_id)
    || toIntOrNull(config?.catalog_template_id);
}

function updateBodyComponent(components, bodyText) {
  const parsed = parseJson(components, []);
  if (!Array.isArray(parsed) || !parsed.length) {
    return [{ type: 'BODY', text: bodyText }];
  }
  let touched = false;
  const next = parsed.map((component) => {
    if (cleanString(component?.type).toUpperCase() !== 'BODY') return component;
    touched = true;
    return { ...component, text: bodyText };
  });
  return touched ? next : [...next, { type: 'BODY', text: bodyText }];
}

function updateSendNodeConfig(config) {
  const next = { ...(config || {}) };
  const catalogId = getCatalogIdFromConfig(next);
  let changed = false;

  if (FOLLOWUP_CATALOG_IDS.has(catalogId)) {
    if (next.quiet_hours_enabled !== true) {
      next.quiet_hours_enabled = true;
      changed = true;
    }
    if (next.outside_send_window_policy !== 'discard') {
      next.outside_send_window_policy = 'discard';
      changed = true;
    }
  }

  const manualText = MANUAL_TEXT_BY_CATALOG_ID[catalogId];
  if (manualText && next.manual_message_text !== manualText) {
    next.manual_message_text = manualText;
    changed = true;
  }

  const routing = next.language_routing && typeof next.language_routing === 'object'
    ? { ...next.language_routing }
    : null;
  const variants = routing?.variants && typeof routing.variants === 'object' && !Array.isArray(routing.variants)
    ? { ...routing.variants }
    : null;

  if (variants) {
    for (const [locale, variant] of Object.entries(variants)) {
      if (!variant || typeof variant !== 'object') continue;
      const variantCatalogId = getCatalogIdFromConfig(variant);
      const variantText = MANUAL_TEXT_BY_CATALOG_ID[variantCatalogId];
      if (!variantText || variant.manual_message_text === variantText) continue;
      variants[locale] = { ...variant, manual_message_text: variantText };
      changed = true;
    }
    if (changed) {
      routing.variants = variants;
      next.language_routing = routing;
    }
  }

  return { config: next, changed };
}

function updateAutomationNodes(nodes) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(safeNodes.map((node) => [cleanString(node?.id), node]));
  const changedWaitNodeIds = [];
  let changed = false;

  const nextNodes = safeNodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    if (cleanString(node.type) === 'action/send_whatsapp') {
      const result = updateSendNodeConfig(node.config || {});
      if (!result.changed) return node;
      changed = true;
      return { ...node, config: result.config };
    }
    return node;
  });

  const nextById = new Map(nextNodes.map((node) => [cleanString(node?.id), node]));
  const withWaits = nextNodes.map((node) => {
    if (!node || cleanString(node.type) !== 'delay/wait_response') return node;
    const timeoutTarget = cleanString(node.outputs?.on_timeout);
    const sendNode = nextById.get(timeoutTarget) || byId.get(timeoutTarget);
    const sendCatalogId = getCatalogIdFromConfig(sendNode?.config || {});
    if (!FOLLOWUP_CATALOG_IDS.has(sendCatalogId)) return node;

    const config = { ...(node.config || {}) };
    if (Number(config.timeout_duration) === 2 && cleanString(config.timeout_unit) === 'hours') {
      return node;
    }
    config.timeout_duration = 2;
    config.timeout_unit = 'hours';
    changed = true;
    changedWaitNodeIds.push(cleanString(node.id));
    return { ...node, config };
  });

  return { nodes: withWaits, changed, changedWaitNodeIds };
}

function parseDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function updateCatalog(queryInterface) {
  const ids = Object.keys(CATALOG_BODY_BY_ID).map(Number);
  const [rows] = await queryInterface.sequelize.query(
    'SELECT id, components FROM WhatsappTemplateCatalog WHERE id IN (:ids)',
    { replacements: { ids } }
  );

  for (const row of rows || []) {
    const bodyText = CATALOG_BODY_BY_ID[Number(row.id)];
    if (!bodyText) continue;
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET body_text = :bodyText,
             components = :components,
             propagation_state = NULL,
             last_propagated_at = NULL,
             updated_at = NOW()
       WHERE id = :id
      `,
      {
        replacements: {
          id: row.id,
          bodyText,
          components: JSON.stringify(updateBodyComponent(row.components, bodyText)),
        },
      }
    );
  }
}

async function updateAutomationTemplates(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(
    `
    SELECT id, nodes
      FROM AutomationFlowTemplatesV2
     WHERE is_active = 1
       AND (
         CAST(nodes AS CHAR) LIKE '%clinicaclick_confirmacion_datos_cita_hoy_sin_respuesta%'
         OR CAST(nodes AS CHAR) LIKE '%clinicaclick_confirmacion_datos_cita_24_sin_respuesta%'
         OR CAST(nodes AS CHAR) LIKE '%clinicaclick_confirmacion_datos_cita_48_sin_respuesta%'
         OR CAST(nodes AS CHAR) LIKE '%clinicaclick_recordatorio_dia_antes_sin_respuesta%'
       )
    `
  );

  const touchedWaitsByTemplate = new Map();
  for (const row of rows || []) {
    const result = updateAutomationNodes(parseJson(row.nodes, []));
    if (!result.changed) continue;
    await queryInterface.sequelize.query(
      `
      UPDATE AutomationFlowTemplatesV2
         SET nodes = :nodes,
             updated_at = NOW()
       WHERE id = :id
      `,
      {
        replacements: {
          id: row.id,
          nodes: JSON.stringify(result.nodes),
        },
      }
    );
    if (result.changedWaitNodeIds.length) {
      touchedWaitsByTemplate.set(Number(row.id), new Set(result.changedWaitNodeIds));
    }
  }
  return touchedWaitsByTemplate;
}

async function updateQueuedExecutionJob(queryInterface, executionId, waitUntil) {
  await queryInterface.sequelize.query(
    `
    UPDATE JobRequests
       SET status = 'waiting',
           next_run_at = :waitUntil,
           updated_at = NOW()
     WHERE type = 'automations_v2_execute'
       AND status IN ('pending', 'queued', 'waiting')
       AND (
         JSON_EXTRACT(payload, '$.execution_id') = :executionId
         OR JSON_EXTRACT(payload, '$.executionId') = :executionId
       )
       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resume_mode')), 'timeout') <> 'response'
    `,
    {
      replacements: {
        executionId,
        waitUntil,
      },
    }
  );
}

async function updatePendingWaitExecutions(queryInterface, touchedWaitsByTemplate) {
  if (!touchedWaitsByTemplate.size) return;

  const templateIds = Array.from(touchedWaitsByTemplate.keys());
  const [rows] = await queryInterface.sequelize.query(
    `
    SELECT id, template_version_id, current_node_id, wait_until, waiting_meta, context, created_at
      FROM FlowExecutionsV2
     WHERE status = 'waiting'
       AND template_version_id IN (:templateIds)
    `,
    { replacements: { templateIds } }
  );

  for (const row of rows || []) {
    const waitNodeIds = touchedWaitsByTemplate.get(Number(row.template_version_id));
    const currentNodeId = cleanString(row.current_node_id);
    if (!waitNodeIds || !waitNodeIds.has(currentNodeId)) continue;

    const waitingMeta = parseJson(row.waiting_meta, {});
    if (cleanString(waitingMeta.resume_mode) === 'response') continue;

    const context = parseJson(row.context, {});
    const output = context?.outputs && typeof context.outputs === 'object'
      ? context.outputs[currentNodeId]
      : null;
    const waitStartAt = parseDateOrNull(waitingMeta.wait_starts_at)
      || parseDateOrNull(output?.wait_starts_at)
      || parseDateOrNull(row.created_at)
      || new Date();
    const waitUntil = new Date(waitStartAt.getTime() + TWO_HOURS_MS);
    const nextContext = {
      ...(context || {}),
      outputs: {
        ...((context && typeof context.outputs === 'object') ? context.outputs : {}),
        [currentNodeId]: {
          ...(output && typeof output === 'object' ? output : {}),
          timeout_at: waitUntil.toISOString(),
        },
      },
    };

    await queryInterface.sequelize.query(
      `
      UPDATE FlowExecutionsV2
         SET wait_until = :waitUntil,
             context = :context,
             updated_at = NOW()
       WHERE id = :id
         AND status = 'waiting'
      `,
      {
        replacements: {
          id: row.id,
          waitUntil,
          context: JSON.stringify(nextContext),
        },
      }
    );

    await updateQueuedExecutionJob(queryInterface, Number(row.id), waitUntil);
  }
}

module.exports = {
  async up(queryInterface) {
    await updateCatalog(queryInterface);
    const touchedWaitsByTemplate = await updateAutomationTemplates(queryInterface);
    await updatePendingWaitExecutions(queryInterface, touchedWaitsByTemplate);
  },

  async down() {
    // No revertimos plantillas de WhatsApp ni versiones activas: al cambiar BODY,
    // Meta genera revisiones nuevas y las esperas pendientes ya se habran movido.
  },
};
