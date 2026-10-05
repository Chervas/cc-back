'use strict';
// Catalogue browsing needs a clinic, not a patient or a purchased entitlement.
function appointmentProgramPage(items, { page, pageSize }) {
  const available = items.filter(item => item.status === 'active' && item.purchase_enabled === true && item.commercial_ready === true);
  return { items: available.slice((page - 1) * pageSize, page * pageSize), total: available.length, page, page_size: pageSize };
}
module.exports = { appointmentProgramPage };
