'use strict';

function usesExplicitDispatchWindow(dispatch = {}) {
  const mode = String(dispatch.time_mode || dispatch.timeMode || '')
    .trim()
    .toLowerCase();
  return mode === 'specific_time';
}

module.exports = {
  usesExplicitDispatchWindow,
};
