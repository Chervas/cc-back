'use strict';

const {
  cloneClassifyIntentPresetConfig,
} = require('./automation-intent-contract');

const INTENT_MIGRATION_KEY = 'canonical_appointment_intent_v1';
const BENIGN_ACKNOWLEDGEMENT_EXIT_KEY = 'canonical_benign_acknowledgement_exit_v1';
const LEGACY_EXECUTION_ALLOWLIST_KEY = 'legacy_appointment_intent_v1';
const HISTORICAL_INTENT_PRESETS = new Set([
  'confirm_appointment',
  'appointment_unconfirmed_reply',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function buildNodeIdFactory(nodes) {
  const ids = new Set((Array.isArray(nodes) ? nodes : []).map((node) => cleanString(node?.id)).filter(Boolean));
  let next = Array.from(ids).reduce((highest, id) => {
    const match = /^N(\d+)$/.exec(id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;
  return () => {
    let id = `N${next++}`;
    while (ids.has(id)) id = `N${next++}`;
    ids.add(id);
    return id;
  };
}

function positionNear(node, column, row) {
  const x = Number(node?.position?.x);
  const y = Number(node?.position?.y);
  return {
    x: (Number.isFinite(x) ? x : 100) + (column * 280),
    y: (Number.isFinite(y) ? y : 100) + (row * 120),
  };
}

function buildOutputCheck({ id, aiNodeId, field, valueType, rightValue, onTrue, onFalse, position }) {
  return {
    id,
    type: 'condition/field_check',
    config: {
      mode: 'simple',
      left_ref: {
        source: 'node_output',
        node_id: aiNodeId,
        path: field,
        value_type: valueType,
        label: field === 'accion_inequivoca' ? 'Accion inequivoca' : 'Intencion del paciente',
      },
      operator: 'equals',
      right_value: rightValue,
    },
    outputs: { on_true: onTrue || null, on_false: onFalse || null },
    position,
  };
}

function findLegacyDecisionTarget(nodes, startNodeId, aiNodeId, decision) {
  const nodeMap = new Map(nodes.map((node) => [cleanString(node?.id), node]));
  const queue = [cleanString(startNodeId)];
  const visited = new Set();
  while (queue.length) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== 'condition/field_check') continue;
    const ref = node.config?.left_ref || {};
    if (
      cleanString(ref.source) === 'node_output'
      && cleanString(ref.node_id) === cleanString(aiNodeId)
      && cleanString(ref.path) === 'decision'
      && cleanString(node.config?.right_value).toLowerCase() === decision
    ) {
      return cleanString(node.outputs?.on_true) || null;
    }
    queue.push(cleanString(node.outputs?.on_false));
  }
  return null;
}

function markFirstPostClassificationWhatsapp(nodes, startNodeId) {
  const nodeMap = new Map(nodes.map((node) => [cleanString(node?.id), node]));
  const queue = [{ id: cleanString(startNodeId), depth: 0 }];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current.id || visited.has(current.id) || current.depth > 4) continue;
    visited.add(current.id);
    const node = nodeMap.get(current.id);
    if (!node) continue;
    if (node.type === 'action/send_whatsapp') {
      node.config = {
        ...(node.config || {}),
        suppress_if_human_replied: true,
        suppress_if_response_needed: true,
      };
      return true;
    }
    if (node.type.startsWith('condition/') || node.type.startsWith('delay/')) continue;
    queue.push({ id: cleanString(node.outputs?.on_success), depth: current.depth + 1 });
  }
  return false;
}

function markCanonicalConfirmationReplySuppression(rawNodes) {
  const nodes = clone(Array.isArray(rawNodes) ? rawNodes : []);
  const nodeMap = new Map(nodes.map((node) => [cleanString(node?.id), node]));
  const canonicalAiNodes = nodes.filter((node) => (
    node?.type === 'condition/ai_analysis'
    && cleanString(node?.config?.preset_key) === 'classify_intent'
  ));
  const markedNodeIds = new Set();

  const outputCheck = (node, aiNodeId, path) => {
    const ref = node?.config?.left_ref || {};
    return node?.type === 'condition/field_check'
      && cleanString(ref.source) === 'node_output'
      && cleanString(ref.node_id) === cleanString(aiNodeId)
      && cleanString(ref.path) === path;
  };
  const booleanBranch = (node, expected) => {
    const rightValue = node?.config?.right_value;
    const rightBoolean = rightValue === true
      || rightValue === 1
      || ['true', '1', 'yes', 'si', 'sí'].includes(cleanString(rightValue).toLowerCase());
    return cleanString(expected === rightBoolean ? node?.outputs?.on_true : node?.outputs?.on_false);
  };

  for (const aiNode of canonicalAiNodes) {
    const confirmationChecks = nodes.filter((node) => (
      outputCheck(node, aiNode.id, 'intencion_principal')
      && cleanString(node?.config?.operator || 'equals') === 'equals'
      && cleanString(node?.config?.right_value) === 'confirmar_cita'
    ));
    for (const confirmationCheck of confirmationChecks) {
      const queue = [{ id: cleanString(confirmationCheck?.outputs?.on_true), depth: 0 }];
      const visited = new Set();
      while (queue.length) {
        const current = queue.shift();
        if (!current.id || current.depth > 20 || visited.has(current.id)) continue;
        visited.add(current.id);
        const node = nodeMap.get(current.id);
        if (!node) continue;

        if (['action/send_whatsapp', 'action/reply_message'].includes(cleanString(node.type))) {
          if (node?.config?.suppress_if_response_needed !== true) {
            node.config = {
              ...(node.config || {}),
              suppress_if_response_needed: true,
            };
            markedNodeIds.add(cleanString(node.id));
          }
          continue;
        }

        if (outputCheck(node, aiNode.id, 'accion_inequivoca')) {
          queue.push({ id: booleanBranch(node, true), depth: current.depth + 1 });
          continue;
        }
        if (outputCheck(node, aiNode.id, 'necesita_respuesta')) {
          queue.push({ id: booleanBranch(node, false), depth: current.depth + 1 });
          continue;
        }
        if (cleanString(node.type).startsWith('condition/')) {
          Object.values(node.outputs || {}).forEach((target) => {
            queue.push({ id: cleanString(target), depth: current.depth + 1 });
          });
          continue;
        }
        queue.push({ id: cleanString(node?.outputs?.on_success), depth: current.depth + 1 });
      }
    }
  }

  return markedNodeIds.size
    ? { changed: true, marked: markedNodeIds.size, nodes }
    : { changed: false, marked: 0, nodes: rawNodes };
}

function markCanonicalBenignAcknowledgementExit(rawNodes, options = {}) {
  const nodes = clone(Array.isArray(rawNodes) ? rawNodes : []);
  const nextId = buildNodeIdFactory(nodes);
  const additions = [];
  let patched = 0;

  const isIntentCheck = (node, aiNodeId, intent) => {
    const ref = node?.config?.left_ref || {};
    return node?.type === 'condition/field_check'
      && cleanString(ref.source) === 'node_output'
      && cleanString(ref.node_id) === cleanString(aiNodeId)
      && cleanString(ref.path) === 'intencion_principal'
      && cleanString(node?.config?.operator || 'equals') === 'equals'
      && cleanString(node?.config?.right_value) === intent;
  };
  const isPendingResponseCheck = (node, aiNodeId) => {
    const ref = node?.config?.left_ref || {};
    return node?.type === 'condition/field_check'
      && cleanString(ref.source) === 'node_output'
      && cleanString(ref.node_id) === cleanString(aiNodeId)
      && cleanString(ref.path) === 'necesita_respuesta'
      && cleanString(node?.config?.operator || 'equals') === 'equals'
      && node?.config?.right_value === false
      && cleanString(node?.config?.migration_key) === BENIGN_ACKNOWLEDGEMENT_EXIT_KEY;
  };

  const buildPendingResponseCheck = ({ id, aiNodeId, reviewTarget, position }) => ({
    id,
    type: 'condition/field_check',
    config: {
      mode: 'simple',
      left_ref: {
        source: 'node_output',
        node_id: aiNodeId,
        path: 'necesita_respuesta',
        value_type: 'boolean',
        label: 'Necesita respuesta de la clinica',
      },
      operator: 'equals',
      right_value: false,
      migration_key: BENIGN_ACKNOWLEDGEMENT_EXIT_KEY,
    },
    outputs: {
      on_true: null,
      on_false: reviewTarget,
    },
    position,
  });

  const canonicalAiNodes = nodes.filter((node) => (
    node?.type === 'condition/ai_analysis'
    && cleanString(node?.config?.preset_key) === 'classify_intent'
    && (
      cleanString(node?.config?.migration_key) === INTENT_MIGRATION_KEY
      || options.includeUnmarked === true
    )
  ));

  for (const aiNode of canonicalAiNodes) {
    const existingAcknowledgementCheck = [...nodes, ...additions].find((node) => (
      isIntentCheck(node, aiNode.id, 'agradecimiento')
      && cleanString(node?.config?.migration_key) === BENIGN_ACKNOWLEDGEMENT_EXIT_KEY
    ));
    if (existingAcknowledgementCheck) {
      const existingPendingResponseCheck = [...nodes, ...additions].find((node) => (
        isPendingResponseCheck(node, aiNode.id)
        && cleanString(node.id) === cleanString(existingAcknowledgementCheck?.outputs?.on_true)
      ));
      if (existingPendingResponseCheck) continue;

      const reviewTarget = cleanString(existingAcknowledgementCheck?.outputs?.on_false) || null;
      if (!reviewTarget) continue;
      const pendingResponseCheckId = nextId();
      existingAcknowledgementCheck.outputs = {
        ...(existingAcknowledgementCheck.outputs || {}),
        on_true: pendingResponseCheckId,
      };
      additions.push(buildPendingResponseCheck({
        id: pendingResponseCheckId,
        aiNodeId: aiNode.id,
        reviewTarget,
        position: positionNear(existingAcknowledgementCheck, 1, 1),
      }));
      patched += 1;
      continue;
    }

    const changeChecks = nodes.filter((node) => (
      isIntentCheck(node, aiNode.id, 'solicitar_cambio_cita')
    ));
    for (const changeCheck of changeChecks) {
      const reviewTarget = cleanString(changeCheck?.outputs?.on_false) || null;
      if (!reviewTarget) continue;
      const acknowledgementCheckId = nextId();
      const pendingResponseCheckId = nextId();
      changeCheck.outputs = {
        ...(changeCheck.outputs || {}),
        on_false: acknowledgementCheckId,
      };
      additions.push({
        id: acknowledgementCheckId,
        type: 'condition/field_check',
        config: {
          mode: 'simple',
          left_ref: {
            source: 'node_output',
            node_id: aiNode.id,
            path: 'intencion_principal',
            value_type: 'string',
            label: 'Intencion del paciente',
          },
          operator: 'equals',
          right_value: 'agradecimiento',
          migration_key: BENIGN_ACKNOWLEDGEMENT_EXIT_KEY,
        },
        outputs: {
          on_true: pendingResponseCheckId,
          on_false: reviewTarget,
        },
        position: positionNear(changeCheck, 1, 1),
      });
      additions.push(buildPendingResponseCheck({
        id: pendingResponseCheckId,
        aiNodeId: aiNode.id,
        reviewTarget,
        position: positionNear(changeCheck, 2, 1),
      }));
      patched += 1;
    }
  }

  return patched
    ? { changed: true, patched, nodes: pruneUnreachableNodes([...nodes, ...additions]) }
    : { changed: false, patched: 0, nodes: rawNodes };
}

function pruneUnreachableNodes(nodes) {
  const nodeMap = new Map(nodes.map((node) => [cleanString(node?.id), node]));
  const roots = nodes.filter((node) => cleanString(node?.type).startsWith('trigger/')).map((node) => cleanString(node.id));
  if (!roots.length) return nodes;
  const reachable = new Set();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift();
    if (!id || reachable.has(id)) continue;
    const node = nodeMap.get(id);
    if (!node) continue;
    reachable.add(id);
    Object.values(node.outputs || {}).forEach((target) => {
      const targetId = cleanString(target);
      if (targetId && !reachable.has(targetId)) queue.push(targetId);
    });
  }
  return nodes.filter((node) => reachable.has(cleanString(node?.id)));
}

function transformLegacyIntentNodes(rawNodes) {
  const nodes = clone(Array.isArray(rawNodes) ? rawNodes : []);
  const nextId = buildNodeIdFactory(nodes);
  const additions = [];
  let replaced = 0;

  for (const aiNode of nodes) {
    if (aiNode?.type !== 'condition/ai_analysis') continue;
    const legacyPreset = cleanString(aiNode?.config?.preset_key);
    if (!HISTORICAL_INTENT_PRESETS.has(legacyPreset)) continue;

    const oldSuccess = cleanString(aiNode.outputs?.on_success) || null;
    const oldFailure = cleanString(aiNode.outputs?.on_fail) || null;
    const confirmationTarget = legacyPreset === 'appointment_unconfirmed_reply'
      ? (findLegacyDecisionTarget(nodes, oldSuccess, aiNode.id, 'confirmar') || oldFailure)
      : oldSuccess;
    markFirstPostClassificationWhatsapp(nodes, confirmationTarget);

    const urgencyId = nextId();
    const confirmIntentId = nextId();
    const confirmSafeId = nextId();
    const cancelIntentId = nextId();
    const cancelSafeId = nextId();
    const changeIntentId = nextId();
    const changeSafeId = nextId();
    const cancelActionId = nextId();
    const cancelReplyId = nextId();
    const changeActionId = nextId();
    const changeReplyId = nextId();
    const changeNotifyId = nextId();

    aiNode.config = cloneClassifyIntentPresetConfig({
      mode: cleanString(aiNode.config?.mode) || 'auto',
      max_tokens: Math.max(350, Number(aiNode.config?.max_tokens) || 0),
      migration_key: INTENT_MIGRATION_KEY,
      migrated_from_preset: legacyPreset,
    });
    aiNode.outputs = {
      on_success: urgencyId,
      on_fail: oldFailure,
    };

    additions.push(
      buildOutputCheck({
        id: urgencyId,
        aiNodeId: aiNode.id,
        field: 'posible_urgencia',
        valueType: 'boolean',
        rightValue: true,
        onTrue: oldFailure,
        onFalse: confirmIntentId,
        position: positionNear(aiNode, 1, -3),
      }),
      buildOutputCheck({
        id: confirmIntentId,
        aiNodeId: aiNode.id,
        field: 'intencion_principal',
        valueType: 'string',
        rightValue: 'confirmar_cita',
        onTrue: confirmSafeId,
        onFalse: cancelIntentId,
        position: positionNear(aiNode, 1, -1),
      }),
      buildOutputCheck({
        id: confirmSafeId,
        aiNodeId: aiNode.id,
        field: 'accion_inequivoca',
        valueType: 'boolean',
        rightValue: true,
        onTrue: confirmationTarget,
        onFalse: oldFailure,
        position: positionNear(aiNode, 2, -1),
      }),
      buildOutputCheck({
        id: cancelIntentId,
        aiNodeId: aiNode.id,
        field: 'intencion_principal',
        valueType: 'string',
        rightValue: 'cancelar_cita',
        onTrue: cancelSafeId,
        onFalse: changeIntentId,
        position: positionNear(aiNode, 1, 1),
      }),
      buildOutputCheck({
        id: cancelSafeId,
        aiNodeId: aiNode.id,
        field: 'accion_inequivoca',
        valueType: 'boolean',
        rightValue: true,
        onTrue: cancelActionId,
        onFalse: oldFailure,
        position: positionNear(aiNode, 2, 1),
      }),
      buildOutputCheck({
        id: changeIntentId,
        aiNodeId: aiNode.id,
        field: 'intencion_principal',
        valueType: 'string',
        rightValue: 'solicitar_cambio_cita',
        onTrue: changeSafeId,
        onFalse: oldFailure,
        position: positionNear(aiNode, 1, 3),
      }),
      buildOutputCheck({
        id: changeSafeId,
        aiNodeId: aiNode.id,
        field: 'accion_inequivoca',
        valueType: 'boolean',
        rightValue: true,
        onTrue: changeActionId,
        onFalse: oldFailure,
        position: positionNear(aiNode, 2, 3),
      }),
      {
        id: cancelActionId,
        type: 'action/change_status',
        config: { target_entity: 'appointment', new_status: 'cancelada' },
        outputs: { on_success: cancelReplyId, on_fail: oldFailure },
        position: positionNear(aiNode, 3, 1),
      },
      {
        id: cancelReplyId,
        type: 'action/reply_message',
        config: {
          message_text: 'Gracias por avisarnos. Hemos cancelado tu cita.',
          suppress_if_human_replied: true,
        },
        outputs: { on_success: null, on_fail: oldFailure },
        position: positionNear(aiNode, 4, 1),
      },
      {
        id: changeActionId,
        type: 'action/change_status',
        config: { target_entity: 'appointment', new_status: 'cambio_solicitado' },
        outputs: { on_success: changeReplyId, on_fail: oldFailure },
        position: positionNear(aiNode, 3, 3),
      },
      {
        id: changeReplyId,
        type: 'action/reply_message',
        config: {
          message_text: 'Gracias por avisarnos. Revisamos la agenda y te decimos la disponibilidad cuanto antes.',
          suppress_if_human_replied: true,
        },
        outputs: { on_success: changeNotifyId, on_fail: changeNotifyId },
        position: positionNear(aiNode, 4, 3),
      },
      {
        id: changeNotifyId,
        type: 'action/send_system_notification',
        config: {
          title: 'Cambio de cita solicitado',
          message: '{{paciente.nombre}} ha pedido cambiar su cita. Revisa la conversacion y ofrece una nueva hora.',
          assignee_type: 'role',
          assignee_id: 'personaldeclinica',
          subrole: 'Recepcion / Comercial ventas',
        },
        outputs: { on_success: null, on_fail: null },
        position: positionNear(aiNode, 5, 3),
      },
    );
    replaced += 1;
  }

  if (!replaced) return { changed: false, replaced: 0, nodes: rawNodes };
  const migrated = pruneUnreachableNodes([...nodes, ...additions]).map((node) => {
    if (node.type !== 'delay/wait_response') return node;
    return {
      ...node,
      config: {
        ...(node.config || {}),
        response_buffer_enabled: true,
        response_buffer_delay_seconds: 90,
      },
    };
  });
  const acknowledgementExit = markCanonicalBenignAcknowledgementExit(migrated);
  return {
    changed: true,
    replaced,
    nodes: acknowledgementExit.changed ? acknowledgementExit.nodes : migrated,
  };
}

function hasCanonicalIntentMigration(rawNodes) {
  const nodes = Array.isArray(rawNodes) ? rawNodes : [];
  return nodes.some((node) => (
    node?.type === 'condition/ai_analysis'
    && cleanString(node?.config?.preset_key) === 'classify_intent'
    && cleanString(node?.config?.migration_key) === INTENT_MIGRATION_KEY
  )) && !nodes.some((node) => (
    node?.type === 'condition/ai_analysis'
    && LEGACY_PRESETS.has(cleanString(node?.config?.preset_key))
  ));
}

function buildMessageReceivedTemplateNodes() {
  const aiNodeId = 'N2';
  const check = (id, field, valueType, rightValue, onTrue, onFalse, x, y) => buildOutputCheck({
    id,
    aiNodeId,
    field,
    valueType,
    rightValue,
    onTrue,
    onFalse,
    position: { x, y },
  });
  const nodes = [
    {
      id: 'N1',
      type: 'trigger/message_received',
      config: {
        channel_scope: 'all_connected',
        channels: [],
        timing: 'clinic_closed',
        only_unclaimed: true,
        response_buffer_seconds: 90,
        runtime_fallback_enabled: false,
      },
      outputs: { on_success: aiNodeId },
      position: { x: 100, y: 420 },
    },
    {
      id: aiNodeId,
      type: 'condition/ai_analysis',
      config: cloneClassifyIntentPresetConfig({ mode: 'auto', max_tokens: 700 }),
      outputs: { on_success: 'N3', on_fail: 'N23' },
      position: { x: 380, y: 420 },
    },
    check('N3', 'posible_urgencia', 'boolean', true, 'N21', 'N4', 660, 100),
    check('N4', 'intencion_principal', 'string', 'confirmar_cita', 'N5', 'N9', 660, 300),
    check('N5', 'accion_inequivoca', 'boolean', true, 'N6', 'N19', 940, 260),
    {
      id: 'N6',
      type: 'action/change_status',
      config: { target_entity: 'appointment', new_status: 'recordatorio_confirmado' },
      outputs: { on_success: 'N7', on_fail: 'N19' },
      position: { x: 1220, y: 220 },
    },
    check('N7', 'necesita_respuesta', 'boolean', true, 'N8', 'N24', 1500, 220),
    {
      id: 'N8',
      type: 'action/reply_message',
      config: {
        message_text: 'Gracias. Hemos registrado la confirmacion de tu cita y dejamos tu pregunta pendiente para recepcion.',
        suppress_if_human_replied: true,
      },
      outputs: { on_success: 'N20', on_fail: 'N20' },
      position: { x: 1780, y: 160 },
    },
    check('N9', 'intencion_principal', 'string', 'cancelar_cita', 'N10', 'N13', 660, 500),
    check('N10', 'accion_inequivoca', 'boolean', true, 'N11', 'N19', 940, 460),
    {
      id: 'N11',
      type: 'action/change_status',
      config: { target_entity: 'appointment', new_status: 'cancelada' },
      outputs: { on_success: 'N12', on_fail: 'N19' },
      position: { x: 1220, y: 460 },
    },
    {
      id: 'N12',
      type: 'action/reply_message',
      config: {
        message_text: 'Gracias por avisarnos. Hemos cancelado tu cita.',
        suppress_if_human_replied: true,
      },
      outputs: { on_success: null, on_fail: 'N20' },
      position: { x: 1500, y: 460 },
    },
    check('N13', 'intencion_principal', 'string', 'solicitar_cambio_cita', 'N14', 'N19', 660, 700),
    check('N14', 'accion_inequivoca', 'boolean', true, 'N15', 'N19', 940, 660),
    {
      id: 'N15',
      type: 'action/change_status',
      config: { target_entity: 'appointment', new_status: 'cambio_solicitado' },
      outputs: { on_success: 'N16', on_fail: 'N19' },
      position: { x: 1220, y: 660 },
    },
    {
      id: 'N16',
      type: 'action/reply_message',
      config: {
        message_text: 'Gracias por avisarnos. Revisamos la agenda y te decimos la disponibilidad cuanto antes.',
        suppress_if_human_replied: true,
      },
      outputs: { on_success: 'N17', on_fail: 'N17' },
      position: { x: 1500, y: 660 },
    },
    {
      id: 'N17',
      type: 'action/send_system_notification',
      config: {
        title: 'Cambio de cita solicitado fuera de horario',
        message: '{{paciente.nombre}} ha pedido cambiar su cita. Revisa la conversacion y ofrece una nueva hora.',
        assignee_type: 'role',
        assignee_id: 'personaldeclinica',
        subrole: 'Recepcion / Comercial ventas',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 1780, y: 660 },
    },
    {
      id: 'N19',
      type: 'action/reply_message',
      config: {
        message_text: 'Gracias por escribirnos. La clinica esta cerrada ahora. Hemos dejado tu mensaje pendiente para recepcion y te responderemos cuando vuelva a abrir.',
        suppress_if_human_replied: true,
      },
      outputs: { on_success: 'N20', on_fail: 'N20' },
      position: { x: 1220, y: 860 },
    },
    {
      id: 'N20',
      type: 'action/send_system_notification',
      config: {
        title: 'Mensaje pendiente de revision',
        message: '{{paciente.nombre}} ha escrito fuera de horario y necesita revision de recepcion.',
        assignee_type: 'role',
        assignee_id: 'personaldeclinica',
        subrole: 'Recepcion / Comercial ventas',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 1780, y: 860 },
    },
    {
      id: 'N21',
      type: 'action/reply_message',
      config: {
        message_text: 'Gracias por escribirnos. Tu mensaje queda marcado para revision prioritaria cuando el equipo este disponible. Si se trata de una urgencia, contacta con los servicios de emergencia.',
        suppress_if_human_replied: true,
      },
      outputs: { on_success: 'N22', on_fail: 'N22' },
      position: { x: 940, y: 40 },
    },
    {
      id: 'N22',
      type: 'action/send_system_notification',
      config: {
        title: 'Posible mensaje urgente fuera de horario',
        message: 'La IA ha marcado una conversacion para revision prioritaria. Abre el chat y valida el contexto; no se ha realizado ningun diagnostico.',
        assignee_type: 'role',
        assignee_id: 'personaldeclinica',
        subrole: 'Recepcion / Comercial ventas',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 1220, y: 40 },
    },
    {
      id: 'N23',
      type: 'action/send_system_notification',
      config: {
        title: 'No se pudo analizar un mensaje',
        message: 'Clinicaclick no ha podido clasificar un mensaje recibido fuera de horario. Revisa la conversacion manualmente.',
        assignee_type: 'role',
        assignee_id: 'personaldeclinica',
        subrole: 'Recepcion / Comercial ventas',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 660, y: 1040 },
    },
    {
      id: 'N24',
      type: 'action/reply_message',
      config: {
        message_text: 'Gracias. Hemos registrado la confirmacion de tu cita.',
        suppress_if_human_replied: true,
        suppress_if_response_needed: true,
      },
      outputs: { on_success: null, on_fail: 'N20' },
      position: { x: 1780, y: 280 },
    },
  ];
  const acknowledgementExit = markCanonicalBenignAcknowledgementExit(nodes, {
    includeUnmarked: true,
  });
  return acknowledgementExit.changed ? acknowledgementExit.nodes : nodes;
}

module.exports = {
  BENIGN_ACKNOWLEDGEMENT_EXIT_KEY,
  INTENT_MIGRATION_KEY,
  LEGACY_EXECUTION_ALLOWLIST_KEY,
  buildMessageReceivedTemplateNodes,
  hasCanonicalIntentMigration,
  markCanonicalBenignAcknowledgementExit,
  markCanonicalConfirmationReplySuppression,
  transformLegacyIntentNodes,
};
