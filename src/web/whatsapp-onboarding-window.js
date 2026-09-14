'use strict';
// Fresh, sandboxed gateway frame per attempt. No JWT, cookies for auth, storage
// or legacy Meta SDK state is shared with the application window.
(function (win, doc) {
  const parents = new Set(['https://app.clinicaclick.com', 'https://crm.clinicaclick.com']);
  const meta = new Set(['https://www.facebook.com', 'https://web.facebook.com']);
  const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
  const id = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
  const nonce = Array.from(win.crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join('');
  let parentOrigin; let input; let started = false; let done = false; let code; let selection; let timer;
  const text = value => { doc.getElementById('status').textContent = value; };
  const button = doc.getElementById('authorize'); const cancel = doc.getElementById('cancel');
  function send(type, extra = {}) {
    if (!input || done) return; done = true; clearTimeout(timer); button.disabled = true; cancel.disabled = true;
    win.parent.postMessage({ type, nonce, requestId: input.requestId, ...extra }, parentOrigin);
    code = null; selection = null; input.authorization.state = ''; win.removeEventListener('message', receive);
  }
  function complete() {
    if (!done && started && code && selection) {
      text('Autorización recibida. Comprobando la cuenta…'); send('cc.wa.result', { code, ...selection });
    }
  }
  function receive(event) {
    if (done) return;
    if (!input) {
      if (event.source !== win.parent || !parents.has(event.origin)) return;
      const v = event.data;
      if (exact(v, ['type']) && v.type === 'cc.wa.hello') {
        win.parent.postMessage({ type: 'cc.wa.ready', nonce }, event.origin); return;
      }
      if (!exact(v, ['type','nonce','requestId','expiresAt','mode','authorization']) || v.type !== 'cc.wa.init' || v.nonce !== nonce || !uuid(v.requestId)
        || !['cloud_api','coexistence'].includes(v.mode) || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= Date.now() || v.expiresAt > Date.now() + 600000
        || !exact(v.authorization, ['appId','configId','redirectUri','state']) || !id(v.authorization.appId) || !id(v.authorization.configId)
        || typeof v.authorization.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.authorization.state)) return;
      let uri; try { uri = new URL(v.authorization.redirectUri); } catch { return; }
      if (uri.protocol !== 'https:' || uri.href !== v.authorization.redirectUri || uri.username || uri.password || uri.port || uri.search || uri.hash) return;
      input = JSON.parse(JSON.stringify(v)); parentOrigin = event.origin; cancel.disabled = false;
      timer = setTimeout(() => { text('La autorización ha caducado.'); send('cc.wa.error', { reason: 'expired' }); }, Math.max(1, input.expiresAt - Date.now()));
      const script = doc.createElement('script'); script.src = 'https://connect.facebook.net/es_ES/sdk.js'; script.async = true;
      script.referrerPolicy = 'no-referrer';
      script.onerror = () => { text('No se ha podido cargar la autorización de Meta.'); send('cc.wa.error', { reason: 'sdk_unavailable' }); };
      script.onload = () => {
        if (done) return;
        try {
          win.FB.init({ appId: input.authorization.appId, version: 'v24.0', cookie: false, xfbml: false, status: false, autoLogAppEvents: false });
          button.disabled = false; text('Autoriza solo la cuenta de WhatsApp que quieres vincular.');
        } catch { send('cc.wa.error', { reason: 'sdk_unavailable' }); }
      };
      doc.head.appendChild(script); return;
    }
    // Session logging IDs are untrusted selection hints, not identity proof.
    // Only the SDK callback supplies this attempt's code; the broker separately
    // verifies the code's app/grant/WABA and the selected phone's membership.
    if (!started || !meta.has(event.origin) || !event.source || event.source === win.parent || event.source === win) return;
    let v; try { if (typeof event.data !== 'string' || event.data.length > 16384) return; v = JSON.parse(event.data); } catch { return; }
    if (v?.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (['FINISH','FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(v.event)) {
      const phoneId = v.data?.phone_number_id ?? null;
      const wabaOnly = input.mode === 'coexistence' && v.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' && phoneId === null;
      if (!id(v.data?.waba_id) || !wabaOnly && !id(phoneId)) return;
      if (selection && (selection.wabaId !== v.data.waba_id || selection.phoneId !== phoneId)) {
        send('cc.wa.error', { reason: 'selection_conflict' }); return;
      }
      // Meta documents a WABA-only completion for coexistence. The broker may
      // resolve a unique member; it must reject multiple phones, never guess.
      selection = { wabaId: v.data.waba_id, phoneId }; complete();
    } else if (v.event === 'CANCEL') send('cc.wa.cancel');
    else if (v.event === 'ERROR') send('cc.wa.error', { reason: 'provider_error' });
  }
  button.addEventListener('click', () => {
    if (!input || started || done || button.disabled) return;
    started = true; button.disabled = true; text('Completa la autorización en la ventana de Meta.');
    try {
      win.FB.login(response => {
        if (done) return;
        if (response?.authResponse?.accessToken || response?.authResponse?.access_token) {
          send('cc.wa.error', { reason: 'authorization_incomplete' }); return;
        }
        const value = response?.authResponse?.code;
        if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value)) { send('cc.wa.error', { reason: 'authorization_incomplete' }); return; }
        if (code && code !== value) { send('cc.wa.error', { reason: 'authorization_incomplete' }); return; }
        code = value; complete();
      }, { config_id: input.authorization.configId, response_type: 'code', override_default_response_type: true,
        redirect_uri: input.authorization.redirectUri,
        extras: { setup: {}, ...(input.mode === 'coexistence' ? { featureType: 'whatsapp_business_app_onboarding' } : {}) } });
    } catch { send('cc.wa.error', { reason: 'authorization_incomplete' }); }
  });
  cancel.addEventListener('click', () => send('cc.wa.cancel'));
  if (win.parent === win) { text('Abre esta autorización desde Ajustes de ClinicaClick.'); return; }
  win.addEventListener('message', receive);
  // The parent starts hello after iframe load. Every reply targets its exact
  // verified origin; no configuration/state is broadcast.
})(window, document);
