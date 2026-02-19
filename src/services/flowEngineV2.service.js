'use strict';

const db = require('../../models');

const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function getByPath(obj, path) {
  if (!path) return undefined;
  const safePath = String(path)
    .replace(/^context\./, '')
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');

  const chunks = safePath.split('.').filter(Boolean);
  let current = obj;

  for (const chunk of chunks) {
    if (current === undefined || current === null) return undefined;
    current = current[chunk];
  }

  return current;
}

function resolveTemplateValue(value, context) {
  if (typeof value !== 'string') return value;
  const fullTemplate = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);

  if (fullTemplate) {
    return getByPath(context, fullTemplate[1]);
  }

  if (value.startsWith('context.')) {
    return getByPath(context, value);
  }

  return value;
}

function mergeNodeOutput(context, nodeId, patch) {
  const nextContext = clone(context) || {};
  nextContext.outputs = nextContext.outputs && typeof nextContext.outputs === 'object' ? nextContext.outputs : {};
  const prev = nextContext.outputs[nodeId] && typeof nextContext.outputs[nodeId] === 'object'
    ? nextContext.outputs[nodeId]
    : {};
  nextContext.outputs[nodeId] = {
    ...prev,
    ...patch,
  };
  return nextContext;
}

function readOutputTarget(node, key) {
  const outputs = node?.outputs && typeof node.outputs === 'object' ? node.outputs : {};
  if (!(key in outputs)) return null;
  const raw = outputs[key];
  const target = cleanString(raw);
  return target || null;
}

function resolveDurationMs(duration, unit) {
  const qty = Number(duration);
  if (!Number.isFinite(qty) || qty < 0) return 0;

  const normalized = String(unit || '').toLowerCase();
  if (normalized.startsWith('second')) return qty * 1000;
  if (normalized.startsWith('minute')) return qty * 60 * 1000;
  if (normalized.startsWith('hour')) return qty * 60 * 60 * 1000;
  if (normalized.startsWith('day')) return qty * 24 * 60 * 60 * 1000;
  return qty * 1000;
}

function evaluateFieldCheck(config, context) {
  const left = resolveTemplateValue(config?.field, context);
  const right = resolveTemplateValue(config?.value, context);
  const operator = String(config?.operator || 'equals').toLowerCase();

  if (operator === 'exists') {
    return left !== undefined && left !== null && left !== '';
  }

  if (operator === 'equals') {
    return String(left) === String(right);
  }

  if (operator === 'not_equals') {
    return String(left) !== String(right);
  }

  if (operator === 'contains') {
    return String(left || '').toLowerCase().includes(String(right || '').toLowerCase());
  }

  if (operator === 'greater_than') {
    return Number(left) > Number(right);
  }

  if (operator === 'less_than') {
    return Number(left) < Number(right);
  }

  return false;
}

function evaluateResponseExists(config, context) {
  const listensTo = cleanString(config?.listens_to_node_id);
  if (!listensTo) return false;

  const output = context?.outputs?.[listensTo];
  const responseText = output?.response_text;
  return responseText !== undefined && responseText !== null && String(responseText).trim() !== '';
}

function parseWaitUntilExpression(expression, context) {
  const resolved = resolveTemplateValue(expression, context);
  if (!resolved) return null;

  if (resolved instanceof Date && !Number.isNaN(resolved.getTime())) {
    return resolved;
  }

  const asDate = new Date(resolved);
  if (!Number.isNaN(asDate.getTime())) {
    return asDate;
  }

  return null;
}

async function processNode(node, context) {
  const nodeType = cleanString(node?.type) || 'unknown';
  const config = node?.config && typeof node.config === 'object' ? node.config : {};

  switch (nodeType) {
    case 'action/write_note': {
      const content = resolveTemplateValue(config?.content, context);
      return {
        kind: 'success',
        output: {
          content: content ?? null,
          written: true,
          status: 'ok',
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'action/change_status': {
      return {
        kind: 'success',
        output: {
          previous_status: resolveTemplateValue(config?.previous_status, context) ?? null,
          new_status: resolveTemplateValue(config?.new_status, context) ?? null,
          agenda_icon: resolveTemplateValue(config?.agenda_icon, context) ?? null,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'action/send_whatsapp': {
      return {
        kind: 'success',
        output: {
          message_id: `stub_wa_${Date.now()}`,
          status: 'queued_stub',
          template_id: config?.template_id || null,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'action/send_email': {
      return {
        kind: 'success',
        output: {
          message_id: `stub_mail_${Date.now()}`,
          status: 'queued_stub',
          template_id: config?.template_id || null,
          subject: resolveTemplateValue(config?.subject, context) || null,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'action/create_task': {
      return {
        kind: 'success',
        output: {
          task_id: null,
          title: resolveTemplateValue(config?.title, context) || null,
          assignee_type: config?.assignee_type || null,
          assignee_id: config?.assignee_id || null,
          status: 'created_stub',
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'action/api_call': {
      return {
        kind: 'success',
        output: {
          status_code: 202,
          response_body: { status: 'stubbed' },
          response_headers: {},
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'delay/fixed': {
      const ms = resolveDurationMs(config?.duration ?? 0, config?.unit || 'seconds');
      const waitUntil = new Date(Date.now() + ms);
      return {
        kind: 'waiting',
        output: {
          wait_until: waitUntil.toISOString(),
          reason: 'fixed_delay',
        },
        waiting_meta: {
          type: nodeType,
          next_node_id: readOutputTarget(node, 'on_complete'),
        },
        wait_until: waitUntil,
      };
    }

    case 'delay/wait_until': {
      const waitUntil = parseWaitUntilExpression(config?.datetime_expression, context) || new Date();
      return {
        kind: 'waiting',
        output: {
          wait_until: waitUntil.toISOString(),
          reason: 'wait_until',
        },
        waiting_meta: {
          type: nodeType,
          next_node_id: readOutputTarget(node, 'on_complete'),
        },
        wait_until: waitUntil,
      };
    }

    case 'delay/wait_response': {
      const timeoutMs = resolveDurationMs(config?.timeout_duration ?? 60, config?.timeout_unit || 'minutes');
      const waitUntil = timeoutMs > 0 ? new Date(Date.now() + timeoutMs) : null;
      return {
        kind: 'waiting',
        output: {
          waits_for_response: true,
          listens_to_node_id: cleanString(config?.listens_to_node_id),
          timeout_at: waitUntil ? waitUntil.toISOString() : null,
        },
        waiting_meta: {
          type: nodeType,
          listens_to_node_id: cleanString(config?.listens_to_node_id),
          on_response: readOutputTarget(node, 'on_response'),
          on_timeout: readOutputTarget(node, 'on_timeout'),
        },
        wait_until: waitUntil,
      };
    }

    case 'condition/field_check': {
      const decision = evaluateFieldCheck(config, context);
      return {
        kind: 'success',
        output: {
          decision,
          operator: config?.operator || 'equals',
        },
        next_node_id: decision
          ? readOutputTarget(node, 'on_true')
          : readOutputTarget(node, 'on_false'),
      };
    }

    case 'condition/response_check': {
      const hasResponse = evaluateResponseExists(config, context);
      return {
        kind: 'success',
        output: {
          has_response: hasResponse,
        },
        next_node_id: hasResponse
          ? readOutputTarget(node, 'on_response')
          : readOutputTarget(node, 'on_no_response'),
      };
    }

    default:
      return {
        kind: 'success',
        output: {
          status: 'noop_stub',
          node_type: nodeType,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
  }
}

async function resumeWaitingNode(execution, node, context, { mode, responseText }) {
  const nodeType = cleanString(node?.type) || '';

  if (nodeType === 'delay/wait_response') {
    const useResponse = mode === 'response';
    const nextNode = useResponse
      ? readOutputTarget(node, 'on_response')
      : readOutputTarget(node, 'on_timeout');

    let nextContext = context;
    if (useResponse) {
      nextContext = mergeNodeOutput(nextContext, node.id, {
        response_text: responseText ?? null,
        responded_at: new Date().toISOString(),
      });
    }

    await execution.update({
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context: nextContext,
      last_error: null,
    });

    return { resumed: true, context: nextContext };
  }

  if (nodeType === 'delay/fixed' || nodeType === 'delay/wait_until') {
    const nextNode = readOutputTarget(node, 'on_complete');
    await execution.update({
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context,
      last_error: null,
    });
    return { resumed: true, context };
  }

  await execution.update({
    status: 'running',
    wait_until: null,
    waiting_meta: null,
    last_error: null,
  });

  return { resumed: true, context };
}

async function runExecution(executionId, options = {}) {
  const maxSteps = Number.isInteger(options.maxSteps) ? options.maxSteps : 100;
  const resumeMode = cleanString(options.resumeMode) || null;
  const responseText = options.responseText ?? null;

  const execution = await FlowExecutionV2.findByPk(executionId, {
    include: [{
      model: AutomationFlowTemplateV2,
      as: 'templateVersion',
    }],
  });

  if (!execution) {
    throw new Error('execution_not_found');
  }

  const template = execution.templateVersion;
  if (!template) {
    await execution.update({ status: 'failed', last_error: 'template_version_not_found' });
    return execution;
  }

  const nodes = Array.isArray(template.nodes) ? template.nodes : [];
  const nodeMap = new Map(nodes.map((node) => [cleanString(node?.id), node]));

  let context = clone(execution.context) || {};
  if (!context.outputs || typeof context.outputs !== 'object') {
    context.outputs = {};
  }

  if (execution.status === 'waiting' && resumeMode) {
    if (
      resumeMode === 'timeout'
      && execution.wait_until
      && new Date(execution.wait_until).getTime() > Date.now()
    ) {
      return execution;
    }

    const waitingNodeId = cleanString(execution.current_node_id);
    const waitingNode = waitingNodeId ? nodeMap.get(waitingNodeId) : null;

    if (!waitingNode) {
      await execution.update({ status: 'failed', last_error: 'waiting_node_not_found' });
      return execution;
    }

    const resumeInfo = await resumeWaitingNode(execution, waitingNode, context, {
      mode: resumeMode,
      responseText,
    });

    context = resumeInfo.context;
  }

  let localStatus = execution.status;
  let currentNodeId = cleanString(execution.current_node_id) || cleanString(template.entry_node_id);

  for (let step = 0; step < maxSteps; step += 1) {
    if (localStatus !== 'running') break;

    if (!currentNodeId) {
      await execution.update({
        status: 'completed',
        current_node_id: null,
        context,
        wait_until: null,
        waiting_meta: null,
        last_error: null,
      });
      localStatus = 'completed';
      break;
    }

    const node = nodeMap.get(currentNodeId);
    if (!node) {
      await execution.update({
        status: 'failed',
        current_node_id: null,
        context,
        last_error: `node_not_found:${currentNodeId}`,
      });
      localStatus = 'failed';
      break;
    }

    const startedAt = new Date();
    const log = await FlowExecutionLogV2.create({
      flow_execution_id: execution.id,
      node_id: currentNodeId,
      node_type: cleanString(node.type),
      status: 'running',
      started_at: startedAt,
      audit_snapshot: {
        started_at: startedAt.toISOString(),
      },
    });

    try {
      const result = await processNode(node, context);
      const finishedAt = new Date();

      if (result.kind === 'waiting') {
        context = mergeNodeOutput(context, currentNodeId, {
          ...(result.output || {}),
          status: 'waiting',
          at: finishedAt.toISOString(),
        });

        await log.update({
          status: 'success',
          finished_at: finishedAt,
          audit_snapshot: {
            kind: 'waiting',
            wait_until: result.wait_until ? result.wait_until.toISOString() : null,
            waiting_meta: result.waiting_meta || null,
          },
        });

        await execution.update({
          status: 'waiting',
          current_node_id: currentNodeId,
          context,
          wait_until: result.wait_until || null,
          waiting_meta: result.waiting_meta || null,
          last_error: null,
        });

        localStatus = 'waiting';
        break;
      }

      context = mergeNodeOutput(context, currentNodeId, {
        ...(result.output || {}),
        status: 'success',
        at: finishedAt.toISOString(),
      });

      const nextNodeId = cleanString(result.next_node_id);

      await log.update({
        status: 'success',
        finished_at: finishedAt,
        audit_snapshot: {
          kind: 'success',
          next_node_id: nextNodeId,
        },
      });

      if (!nextNodeId) {
        await execution.update({
          status: 'completed',
          current_node_id: null,
          context,
          wait_until: null,
          waiting_meta: null,
          last_error: null,
        });
        localStatus = 'completed';
        break;
      }

      currentNodeId = nextNodeId;
      await execution.update({
        status: 'running',
        current_node_id: currentNodeId,
        context,
        wait_until: null,
        waiting_meta: null,
        last_error: null,
      });
    } catch (error) {
      const finishedAt = new Date();
      const errorMessage = cleanString(error?.message) || 'node_execution_error';
      const onFailNode = readOutputTarget(node, 'on_fail');

      context = mergeNodeOutput(context, currentNodeId, {
        status: 'error',
        error_message: errorMessage,
        at: finishedAt.toISOString(),
      });

      await log.update({
        status: 'error',
        finished_at: finishedAt,
        error_message: errorMessage,
        audit_snapshot: {
          kind: 'error',
          on_fail: onFailNode,
        },
      });

      if (onFailNode) {
        currentNodeId = onFailNode;
        await execution.update({
          status: 'running',
          current_node_id: currentNodeId,
          context,
          last_error: errorMessage,
        });
      } else {
        await execution.update({
          status: 'failed',
          current_node_id: null,
          context,
          last_error: errorMessage,
        });
        localStatus = 'failed';
        break;
      }
    }
  }

  if (localStatus === 'running') {
    await execution.update({
      status: 'dead_letter',
      last_error: 'max_steps_exceeded',
      context,
    });
  }

  await execution.reload();
  return execution;
}

module.exports = {
  runExecution,
};
