#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildWhatsappTemplateVariableContract,
} = require('../../lib/whatsapp-template-contract');

test('un saludo directo conserva el nombre aunque la copia de Meta tenga variables opacas', () => {
  const contract = buildWhatsappTemplateVariableContract({
    name: 'cc_nos_hemos_trasladado_mueecjp1',
    variables: [
      { index: 1, position: 1, name: '1', example: '1', description: 'Variable 1' },
    ],
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}, te escribimos desde PROPDENTAL de Calle Andrade, solo para informarte que nos hemos trasladado a la Calle Independencia 275.',
        example: { body_text: [['1']] },
      },
    ],
  });

  assert.equal(contract.length, 1);
  assert.equal(contract[0].name, 'nombre_paciente');
});
