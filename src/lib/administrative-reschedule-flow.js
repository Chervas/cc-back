'use strict';

const assert = require('node:assert/strict');
const { ADMINISTRATIVE_ERROR } = require('./appointment-reschedule-reason');
const BRANCH = 'branch_administrative_error';
const STATUS_NODE = 'N95';

// Extend the published unified graph without replacing its other branches or AI contracts.
function buildAdministrativeRescheduleFlow(template) {
  assert.equal(template.trigger_type, 'appointment_rescheduled');
  const nodes = JSON.parse(JSON.stringify(template.nodes));
  const origin = nodes.find(node => node.id === 'N70');
  assert.equal(origin?.type, 'condition/field_check');
  assert.equal(origin.config.mode, 'multi_branch');
  assert(origin.config.branch_rules.some(rule => rule.id === 'branch_patient_request'));
  assert(origin.config.branch_rules.some(rule => rule.id === 'branch_clinic_schedule'));
  const existing = nodes.find(node => node.id === STATUS_NODE);
  if (existing) {
    assert.equal(origin.outputs[BRANCH], STATUS_NODE);
    assert.equal(existing.type, 'action/change_status');
    assert.equal(existing.config.new_status, 'info_confirmada');
    assert(Object.values(existing.outputs).every(value => value === null));
  } else {
    assert(!origin.config.branch_rules.some(rule => rule.id === BRANCH));
    origin.config.display_label = '¿Cuál es el motivo del cambio?';
    origin.config.branch_rules.push({ id: BRANCH, label: 'Error administrativo', comparison_rules: [{
      id: 'rule_1', connector: null,
      left_ref: { source: 'trigger_data', node_id: null, path: 'reschedule_reason', value_type: 'string', label: 'Motivo de reprogramación' },
      operator: 'equals', right_value: ADMINISTRATIVE_ERROR,
    }] });
    origin.outputs[BRANCH] = STATUS_NODE;
    origin.output_schema = { ...origin.output_schema, [BRANCH]: { label: 'Error administrativo' } };
    nodes.push({ id: STATUS_NODE, type: 'action/change_status',
      config: { target_entity: 'appointment', new_status: 'info_confirmada', display_label: 'Datos de cita confirmados · Sin aviso' },
      outputs: { on_success: null, on_fail: null },
      position: { x: (origin.position?.x || 0) + 900, y: (origin.position?.y || 0) + 240 },
    });
  }
  return { entry_node_id: template.entry_node_id, trigger_type: template.trigger_type,
    trigger_config: { ...template.trigger_config, reschedule_reasons: [...new Set([...(template.trigger_config?.reschedule_reasons || []), ADMINISTRATIVE_ERROR])] }, nodes };
}

module.exports = { buildAdministrativeRescheduleFlow, BRANCH, STATUS_NODE };
