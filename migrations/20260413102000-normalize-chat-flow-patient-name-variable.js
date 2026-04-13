'use strict';

function parseJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return value;
    }
  }
  return value;
}

function replaceVariables(value, fromRegex, toToken) {
  if (typeof value === 'string') {
    return value.replace(fromRegex, toToken);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceVariables(item, fromRegex, toToken));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceVariables(item, fromRegex, toToken)])
    );
  }
  return value;
}

async function updateJsonColumn(queryInterface, tableName, idColumn, jsonColumn, idValue, nextValue) {
  await queryInterface.sequelize.query(
    `UPDATE \`${tableName}\` SET \`${jsonColumn}\` = :value WHERE \`${idColumn}\` = :id`,
    {
      replacements: {
        value: JSON.stringify(nextValue),
        id: idValue,
      },
    }
  );
}

async function normalizeColumn(queryInterface, tableName, idColumn, jsonColumn, fromRegex, toToken) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT \`${idColumn}\`, \`${jsonColumn}\` FROM \`${tableName}\` WHERE \`${jsonColumn}\` IS NOT NULL`
  );

  for (const row of rows) {
    const current = parseJson(row[jsonColumn]);
    const next = replaceVariables(current, fromRegex, toToken);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      await updateJsonColumn(queryInterface, tableName, idColumn, jsonColumn, row[idColumn], next);
    }
  }
}

module.exports = {
  async up(queryInterface) {
    const fromRegex = /\{\{\s*nombre\s*\}\}/g;
    await normalizeColumn(queryInterface, 'ChatFlowTemplates', 'id', 'flow', fromRegex, '{{paciente.nombre}}');
    await normalizeColumn(queryInterface, 'ChatFlowTemplates', 'id', 'flows', fromRegex, '{{paciente.nombre}}');
    await normalizeColumn(queryInterface, 'ChatFlowTemplates', 'id', 'texts', fromRegex, '{{paciente.nombre}}');
    await normalizeColumn(queryInterface, 'IntakeConfigs', 'id', 'config', fromRegex, '{{paciente.nombre}}');
  },

  async down(queryInterface) {
    const fromRegex = /\{\{\s*paciente\.nombre\s*\}\}/g;
    await normalizeColumn(queryInterface, 'ChatFlowTemplates', 'id', 'flow', fromRegex, '{{nombre}}');
    await normalizeColumn(queryInterface, 'ChatFlowTemplates', 'id', 'flows', fromRegex, '{{nombre}}');
    await normalizeColumn(queryInterface, 'ChatFlowTemplates', 'id', 'texts', fromRegex, '{{nombre}}');
    await normalizeColumn(queryInterface, 'IntakeConfigs', 'id', 'config', fromRegex, '{{nombre}}');
  },
};
