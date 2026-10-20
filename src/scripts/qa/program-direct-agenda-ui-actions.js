'use strict';

// Reusable native UI actions for the retained synthetic DEV scenario and its
// later screen recording. No API stubs, Angular debug injection, credentials,
// SQL or transport; the caller owns scope/request allowlists and evidence.
const assert = require('node:assert/strict');
const selectors = Object.freeze({
  newAppointment: '[data-qa="agenda-create-fab"]', drawer: '[data-qa="agenda-new-drawer"]',
  patientSearch: '[data-qa="appointment-patient-search"]', type: '[data-qa="agenda-new-type-treatment"] mat-select',
  serviceTabs: '[data-qa="appointment-treatment-tabs"]', programSearch: 'input[placeholder="Buscar programa"]',
  browsePrograms: '[data-qa="appointment-browse-clinical-programs"]',
  assign: '[data-qa="appointment-assign-clinical-program"]', enrollment: 'app-program-enrollment-dialog',
  confirmEnrollment: '[data-qa="program-enrollment-confirm"]', planner: 'app-program-booking-dialog',
  searchDate: 'input[aria-label="Primer día de búsqueda"]', confirmBooking: '[data-qa="program-booking-confirm"]',
  chooseDate: '[data-qa="program-choose-date"]', viewAppointment: '[data-qa="program-view-appointment"]',
});
function createActions(page) {
  const visible = selector => page.$eval(selector, node => !!node.getClientRects().length).catch(() => false);
  const click = async (selector, text) => {
    const handle = await page.evaluateHandle(({ selector, text }) => [...document.querySelectorAll(selector)]
      .find(node => node.getClientRects().length && !node.disabled && (!text || node.textContent.includes(text))), { selector, text });
    const element = handle.asElement(); assert(element, `VISIBLE_NATIVE_CONTROL_REQUIRED:${selector}:${text || ''}`);
    // DOM activation of the visible native control avoids Chromium's hidden
    // tab IntersectionObserver wait. This is still the real Angular handler,
    // not a component method/debug hook or a substituted HTTP response.
    await element.evaluate(node => {
      node.scrollIntoView({ block: 'center' });
      (node.matches('mat-checkbox') ? node.querySelector('input[type="checkbox"]') : node).click();
    }); await handle.dispose();
  };
  const input = async (selector, value) => {
    await page.waitForSelector(selector, { visible: true }); await page.focus(selector);
    await page.$eval(selector, (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  };
  const idle = async () => { await page.waitForFunction(selector => !document.querySelector(selector + ' mat-progress-bar'), { timeout: 45000 }, selectors.planner); };
  const waitPlanner = async () => { await page.waitForSelector(selectors.planner + ' h2', { visible: true }); await idle(); };
  const setType = async label => { await click(selectors.type); await click('mat-option', label); };
  async function openPatientDrawer(patientLabel) {
    if (!await visible(selectors.drawer)) await click(selectors.newAppointment);
    await page.waitForSelector(selectors.drawer, { visible: true });
    if (await visible(selectors.patientSearch)) { await input(selectors.patientSearch, patientLabel); await page.waitForFunction(label =>
      [...document.querySelectorAll('mat-option')].some(node => node.getClientRects().length && node.textContent.includes(label)), { timeout: 30000 }, patientLabel);
      await click('mat-option', patientLabel); }
  }
  async function chooseProgram(programName) {
    if (!await visible(selectors.serviceTabs)) await setType('con tratamiento');
    await click(selectors.serviceTabs + ' button', 'Programas');
    if (await visible(selectors.browsePrograms)) await click(selectors.browsePrograms);
    await input(selectors.programSearch, programName);
    await page.waitForFunction(name => [...document.querySelectorAll('mat-option')].some(node => node.getClientRects().length && node.textContent.includes(name)), { timeout: 30000 }, programName);
    await click('mat-option', programName); await click(selectors.assign);
    await page.waitForSelector(selectors.confirmEnrollment, { visible: true });
  }
  async function cancelEnrollment() { await click(selectors.enrollment + ' button', 'Cancelar'); await page.waitForFunction(selector => !document.querySelector(selector), {}, selectors.enrollment); }
  async function assignProgram() { await click(selectors.confirmEnrollment); await waitPlanner(); }
  async function openExistingProgram(programName) {
    await setType('Continuación'); await click(selectors.serviceTabs + ' button', 'Programas');
    const pending = '[data-qa="appointment-pending-clinical-programs"] button';
    await page.waitForFunction(({ selector, name }) => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length && node.textContent.includes(name)),
      { timeout: 30000 }, { selector: pending, name: programName });
    await click(pending, programName); await waitPlanner();
  }
  async function proposeDates(firstDay) { await input(selectors.searchDate, firstDay); await click(selectors.planner + ' button', 'Proponer fechas'); await idle(); }
  async function selectSession(key, selected) {
    const selector = `[data-session-key="${key}"] mat-checkbox`;
    assert(await visible(selector), 'PROGRAM_SESSION_CHECKBOX_REQUIRED:' + key);
    if (await page.$eval(selector + ' input', node => node.checked) !== selected) await click(selector);
  }
  async function confirmDates() { await click(selectors.confirmBooking); await idle(); await page.waitForSelector(selectors.viewAppointment, { visible: true, timeout: 30000 }); }
  async function closePlanner() {
    await click(selectors.planner + ' button[aria-label="Cerrar planificador"]');
    await page.waitForFunction(selector => !document.querySelector(selector), {}, selectors.planner);
    // afterClosed refreshes/closes the parent drawer after Material finishes
    // detaching the overlay. Let that native animation settle before a new FAB.
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { click, input, visible, idle, waitPlanner, setType, openPatientDrawer, chooseProgram, cancelEnrollment, assignProgram,
    openExistingProgram, proposeDates, selectSession, confirmDates, closePlanner, selectors };
}
module.exports = { selectors, createActions };
