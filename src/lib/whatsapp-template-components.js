'use strict';

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function normalizeScalarForComparison(key, value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (key === 'type' || key === 'format') return trimmed.toUpperCase();
  return trimmed;
}

function normalizeObjectForComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized = {};
  Object.keys(value)
    .filter((key) => key !== 'example')
    .sort()
    .forEach((key) => {
      normalized[key] = normalizeValueForComparison(key, value[key]);
    });
  return normalized;
}

function normalizeValueForComparison(key, value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValueForComparison(key, item));
  }
  if (value && typeof value === 'object') {
    return normalizeObjectForComparison(value);
  }
  return normalizeScalarForComparison(key, value);
}

function normalizeTemplateComponentsForComparison(value) {
  const components = parseMaybeJson(value) || [];
  if (!Array.isArray(components)) return [];
  return components.map((component) => normalizeObjectForComparison(component));
}

function stringifyComparableTemplateComponents(value) {
  return JSON.stringify(normalizeTemplateComponentsForComparison(value));
}

function haveSameTemplateComponents(left, right) {
  return stringifyComparableTemplateComponents(left) === stringifyComparableTemplateComponents(right);
}

module.exports = {
  haveSameTemplateComponents,
  normalizeTemplateComponentsForComparison,
  stringifyComparableTemplateComponents,
};
