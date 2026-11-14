// Tectobox frontend — views/connect.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- QR connect ----------------
// Custom slot-name dialog (Aurora-styled) — replaces the native browser prompt().
function askSlotLabel(channel) {
  return new Promise((resolve) => {
    const modal = $('slot-modal'), input = $('slot-label');
    $('slot-title').textContent = `Name this ${channel} account`;
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
    const done = (val) => {
      modal.classList.add('hidden');
      $('btn-slot-ok').onclick = $('btn-slot-cancel').onclick = input.onkeydown = null;
      resolve(val);
    };
    $('btn-slot-ok').onclick = () => done(input.value.trim() || null);
    $('btn-slot-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      else if (e.key === 'Escape') done(null);
    };
    modal.onclick = (e) => { if (e.target === modal) done(null); };
  });
}
// Promise-based confirm dialog (Aurora-styled) — replaces the native
// confirm(), which is blocking, visually off-brand, and invisible to
// automation/testing layers (every confirm()-gated button looked "dead"
// in automated QA because the native dialog never surfaced).
function askConfirm(title, body, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body || '';
    $('confirm-body').style.display = body ? '' : 'none';
    const okBtn = $('btn-confirm-ok');
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('btn-danger-soft', danger);
    okBtn.classList.toggle('btn-primary', !danger);
    modal.classList.remove('hidden');
    const done = (val) => {
      modal.classList.add('hidden');
      okBtn.onclick = $('btn-confirm-cancel').onclick = modal.onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => done(true);
    $('btn-confirm-cancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}
async function addAccount(channel) {
  // Every Connect asks how first: QR scan or phone number. That choice is
  // the premium part — the modal below never assumes a method.
  const method = await askConnectMethod(channel);
  if (!method) return; // cancelled
  const label = await askSlotLabel(channel);
  if (label === null) return; // cancelled
  const slot = (label.trim() || 'account').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'account';
  const body = { slot, label: label.trim() || slot };
  if (method === 'phone') {
    const phoneNumber = await askPhoneNumber(channel);
    if (!phoneNumber) return; // cancelled
    body.method = 'phone';
    body.phoneNumber = phoneNumber;
    try {
      await api(`/api/clients/${state.clientId}/connectors/${channel}/connect`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
    startPhoneConnect(channel, slot, label.trim() || slot, phoneNumber);
  } else {
    try {
      await api(`/api/clients/${state.clientId}/connectors/${channel}/connect`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
    startQrConnect(channel, slot, label.trim() || slot);
  }
}
// Connect method picker — QR scan or phone number. Promise-based, same
// pattern as askSlotLabel/askConfirm (no native dialogs anywhere).
function askConnectMethod(channel) {
  return new Promise((resolve) => {
    const modal = $('method-modal');
    $('method-title').textContent = `Connect ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'}`;
    $('method-sub').textContent = channel === 'whatsapp'
      ? 'Choose how you want to link this WhatsApp account'
      : 'Choose how you want to link this Telegram account';
    modal.classList.remove('hidden');
    const done = (val) => {
      modal.classList.add('hidden');
      $('method-qr').onclick = $('method-phone').onclick = $('btn-method-cancel').onclick = modal.onclick = null;
      resolve(val);
    };
    $('method-qr').onclick = () => done('qr');
    $('method-phone').onclick = () => done('phone');
    $('btn-method-cancel').onclick = () => done(null);
    modal.onclick = (e) => { if (e.target === modal) done(null); };
  });
}
// Every dial code, [code, name] — Bangladesh first (default), the rest
// alphabetical. The picker stops the classic failure: a number typed in
// local format (leading 0, no country code) makes WhatsApp drop the socket
// and the modal just says "Connection Closed".
const COUNTRY_CODES = [['880','Bangladesh'],['93','Afghanistan'],['355','Albania'],['213','Algeria'],
['376','Andorra'],['244','Angola'],['1264','Anguilla'],['1268','Antigua and Barbuda'],['54','Argentina'],
['374','Armenia'],['297','Aruba'],['61','Australia'],['43','Austria'],['994','Azerbaijan'],
['1242','Bahamas'],['973','Bahrain'],['1246','Barbados'],['375','Belarus'],['32','Belgium'],
['501','Belize'],['229','Benin'],['1441','Bermuda'],['975','Bhutan'],['591','Bolivia'],
['387','Bosnia and Herzegovina'],['267','Botswana'],['55','Brazil'],['673','Brunei'],['359','Bulgaria'],
['226','Burkina Faso'],['257','Burundi'],['855','Cambodia'],['237','Cameroon'],['1','Canada'],
['238','Cape Verde'],['1345','Cayman Islands'],['236','Central African Republic'],['235','Chad'],['56','Chile'],
['86','China'],['57','Colombia'],['269','Comoros'],['242','Congo'],['243','DR Congo'],
['506','Costa Rica'],['385','Croatia'],['53','Cuba'],['357','Cyprus'],['420','Czechia'],
['45','Denmark'],['253','Djibouti'],['1767','Dominica'],['1809','Dominican Republic'],['593','Ecuador'],
['20','Egypt'],['503','El Salvador'],['240','Equatorial Guinea'],['291','Eritrea'],['372','Estonia'],
['268','Eswatini'],['251','Ethiopia'],['679','Fiji'],['358','Finland'],['33','France'],
['241','Gabon'],['220','Gambia'],['995','Georgia'],['49','Germany'],['233','Ghana'],
['30','Greece'],['299','Greenland'],['1473','Grenada'],['1671','Guam'],['502','Guatemala'],
['224','Guinea'],['245','Guinea-Bissau'],['592','Guyana'],['509','Haiti'],['504','Honduras'],
['852','Hong Kong'],['36','Hungary'],['354','Iceland'],['91','India'],['62','Indonesia'],
['98','Iran'],['964','Iraq'],['353','Ireland'],['972','Israel'],['39','Italy'],
['1876','Jamaica'],['81','Japan'],['962','Jordan'],['7','Kazakhstan'],['254','Kenya'],
['686','Kiribati'],['965','Kuwait'],['996','Kyrgyzstan'],['856','Laos'],['371','Latvia'],
['961','Lebanon'],['266','Lesotho'],['231','Liberia'],['218','Libya'],['423','Liechtenstein'],
['370','Lithuania'],['352','Luxembourg'],['853','Macao'],['261','Madagascar'],['265','Malawi'],
['60','Malaysia'],['960','Maldives'],['223','Mali'],['356','Malta'],['692','Marshall Islands'],
['222','Mauritania'],['230','Mauritius'],['52','Mexico'],['691','Micronesia'],['373','Moldova'],
['377','Monaco'],['976','Mongolia'],['382','Montenegro'],['212','Morocco'],['258','Mozambique'],
['95','Myanmar'],['264','Namibia'],['674','Nauru'],['977','Nepal'],['31','Netherlands'],
['64','New Zealand'],['505','Nicaragua'],['227','Niger'],['234','Nigeria'],['850','North Korea'],
['389','North Macedonia'],['47','Norway'],['968','Oman'],['92','Pakistan'],['680','Palau'],
['970','Palestine'],['507','Panama'],['675','Papua New Guinea'],['595','Paraguay'],['51','Peru'],
['63','Philippines'],['48','Poland'],['351','Portugal'],['1787','Puerto Rico'],['974','Qatar'],
['40','Romania'],['7','Russia'],['250','Rwanda'],['1869','Saint Kitts and Nevis'],['1758','Saint Lucia'],
['1784','Saint Vincent'],['685','Samoa'],['378','San Marino'],['239','Sao Tome and Principe'],['966','Saudi Arabia'],
['221','Senegal'],['381','Serbia'],['248','Seychelles'],['232','Sierra Leone'],['65','Singapore'],
['421','Slovakia'],['386','Slovenia'],['677','Solomon Islands'],['252','Somalia'],['27','South Africa'],
['82','South Korea'],['211','South Sudan'],['34','Spain'],['94','Sri Lanka'],['249','Sudan'],
['597','Suriname'],['46','Sweden'],['41','Switzerland'],['963','Syria'],['886','Taiwan'],
['992','Tajikistan'],['255','Tanzania'],['66','Thailand'],['228','Togo'],['676','Tonga'],
['1868','Trinidad and Tobago'],['216','Tunisia'],['90','Turkey'],['993','Turkmenistan'],['688','Tuvalu'],
['256','Uganda'],['380','Ukraine'],['971','UAE'],['44','United Kingdom'],['1','United States'],
['598','Uruguay'],['998','Uzbekistan'],['678','Vanuatu'],['379','Vatican'],['58','Venezuela'],
['84','Vietnam'],['967','Yemen'],['260','Zambia'],['263','Zimbabwe']];
// Phone number entry for phone login. Returns digits only (country code
// included, no '+'), or null on cancel. The country-code picker + the
// normalization below guarantee international format: leading zeros are
// stripped, and a pasted full number (already starting with the code) is
// not double-prefixed.
function askPhoneNumber(channel) {
  return new Promise((resolve) => {
    const modal = $('phone-modal'), input = $('phone-number'), cc = $('phone-cc');
    if (!cc.options.length) {
      for (const [code, name] of COUNTRY_CODES) {
        const o = document.createElement('option');
        o.value = code; o.textContent = `+${code} ${name}`;
        if (code === '880') o.selected = true;
        cc.appendChild(o);
      }
    }
    $('phone-title').textContent = `Your ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} number`;
    $('phone-sub').textContent = channel === 'whatsapp'
      ? 'Pick your country code, then type your WhatsApp number — without the leading 0'
      : 'Pick your country code, then type your Telegram number — without the leading 0';
    $('phone-err').textContent = '';
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
    const done = (val) => {
      modal.classList.add('hidden');
      $('btn-phone-ok').onclick = $('btn-phone-cancel').onclick = input.onkeydown = modal.onclick = null;
      resolve(val);
    };
    const submit = () => {
      const code = cc.value.replace(/[^0-9]/g, '');
      const hadPlus = input.value.trim().startsWith('+');
      const local = input.value.replace(/[^0-9]/g, '').replace(/^0+/, '');
      if (!local) {
        $('phone-err').textContent = 'Type your number (without the leading 0).';
        return;
      }
      // A pasted full number must not be double-prefixed — but a local
      // number can coincidentally start with a 1-digit code (US '1':
      // local 171... is NOT the full number). So "already prefixed" only
      // counts for a '+' paste or a >=11-digit number starting with the code.
      const digits = (hadPlus || (local.startsWith(code) && local.length >= 11)) ? local : code + local;
      if (!/^[0-9]{7,15}$/.test(digits) || local.length < 6) {
        $('phone-err').textContent = 'Enter a valid number — pick the country code, then your number without the leading 0.';
        return;
      }
      done(digits);
    };
    $('btn-phone-ok').onclick = submit;
    $('btn-phone-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') done(null);
    };
    modal.onclick = (e) => { if (e.target === modal) done(null); };
  });
}
// Shared lifecycle for the connect modal (QR + phone): poll the connector
// status while the modal is open. SSE 'channel_status' can be missed
// (reboot / dropped EventSource / modal opened late) which used to leave
// the modal stuck even though the phone paired fine. Polling is the source
// of truth; onPollExtra handles the method-specific arrival (QR image,
// pairing code, code-sent flag). Auto-closes the moment the account
// connects; hard-stops the poll after 3 minutes.
function setupConnectModal(channel, slot, onPollExtra) {
  state.qrChannel = channel;
  state.qrSlot = slot;
  if (state.qrPoll) { clearInterval(state.qrPoll); clearTimeout(state.qrPollKill); state.qrPoll = null; }
  const pollSlot = slot, pollChannel = channel;
  const closeQrModal = (opts) => {
    if (state.qrPoll) { clearInterval(state.qrPoll); clearTimeout(state.qrPollKill); state.qrPoll = null; }
    $('qr-modal').classList.add('hidden');
    const ch = state.qrChannel, sl = state.qrSlot;
    state.qrChannel = null;
    state.qrSlot = null;
    state.qrMethod = null;
    state.qrPhone = null;
    if (opts && opts.abandon && ch && sl) {
      // Cancelled halfway: the attempt never succeeded, so its row must not
      // linger in the list (it used to reappear as 'pending' after a
      // refresh). Delete it — but only after a fresh read confirms it still
      // isn't 'connected', so a scan that landed a moment earlier is never
      // wiped. Fire-and-forget: the modal closes instantly either way.
      api(`/api/clients/${state.clientId}/connectors`).then(s => {
        const accts = (((ch === 'whatsapp' ? s.whatsapp : s.telegram) || {}).accounts) || [];
        const acct = accts.find(a => (a.slot || 'default') === (sl || 'default'));
        if (acct && acct.status !== 'connected') {
          api(`/api/clients/${state.clientId}/connectors/${ch}/${encodeURIComponent(sl)}`, { method: 'DELETE' }).catch(() => {});
        }
      }).catch(() => {});
    }
    if (state.view === 'settings') loadConnectors();
  };
  state.qrClose = closeQrModal;
  state.qrPoll = setInterval(async () => {
    try {
      const s = await api(`/api/clients/${state.clientId}/connectors`);
      const accounts = (pollChannel === 'whatsapp' ? (s.whatsapp && s.whatsapp.accounts) : (s.telegram && s.telegram.accounts)) || [];
      const acct = accounts.find(a => (a.slot || 'default') === (pollSlot || 'default'));
      if (acct && acct.status === 'connected') closeQrModal();
      else if (acct && onPollExtra) onPollExtra(acct);
    } catch {}
  }, 3000);
  state.qrPollKill = setTimeout(() => {
    if (state.qrPoll) { clearInterval(state.qrPoll); state.qrPoll = null; }
  }, 180000);
}
// QR image setter (single path for the poll + the SSE 'qr' event): the skeleton
// shows while the code generates; on load the code fades/scales in over it.
// Re-setting the same data URL is a no-op (no flicker on repeated polls).
function setQrImage(src) {
  if (!src) return;
  const img = $('qr-img');
  if (img.getAttribute('src') === src) return;
  const box = $('qr-box');
  box.classList.remove('qr-ready');
  $('qr-status').textContent = 'Generating your secure code…';
  img.onload = () => {
    box.classList.add('qr-ready');
    $('qr-status').textContent = 'Waiting for scan… the code refreshes automatically.';
  };
  img.src = src;
}
async function startQrConnect(channel, slot = 'default', label = null) {
  if (slot === 'default' && !label) {
    try {
      await api(`/api/clients/${state.clientId}/connectors/${channel}/connect`, { method: 'POST' });
    } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
  }
  state.qrMethod = 'qr';
  $('qr-title').textContent = (channel === 'whatsapp' ? 'Scan with WhatsApp' : 'Scan with Telegram') + (label ? ` — ${label}` : '');
  $('qr-sub').textContent = channel === 'whatsapp'
    ? 'WhatsApp → ⋮ menu → Linked devices → Link a device'
    : 'Telegram → Settings → Devices → Link Desktop Device';
  // QR view on, phone view off; reset to the skeleton state: the code
  // fades/scales in over it when it arrives.
  $('qr-view').classList.remove('hidden');
  $('phone-view').classList.add('hidden');
  $('qr-box').classList.remove('qr-ready');
  $('qr-status').textContent = 'Generating your secure code…';
  $('qr-img').removeAttribute('src');
  $('qr-modal').classList.remove('hidden');
  setupConnectModal(channel, slot, (acct) => { if (acct.qr) setQrImage(acct.qr); });
}
// Phone login modal: WhatsApp shows the big pairing code, Telegram shows
// the 5-digit code entry. Same modal shell + poll/close lifecycle as the
// QR flow — only the middle view differs.
function startPhoneConnect(channel, slot = 'default', label = null, phoneNumber = '') {
  state.qrMethod = 'phone';
  state.qrPhone = phoneNumber;
  state.qrLabel = label;
  $('qr-title').textContent = (channel === 'whatsapp' ? 'Connect WhatsApp' : 'Connect Telegram') + (label ? ` — ${label}` : '');
  $('qr-sub').textContent = channel === 'whatsapp'
    ? 'No scanning — enter the code on your phone'
    : 'Enter the code Telegram just sent you';
  $('qr-view').classList.add('hidden');
  $('phone-view').classList.remove('hidden');
  if (channel === 'whatsapp') {
    $('pairing-wrap').classList.remove('hidden');
    $('tg-code-wrap').classList.add('hidden');
    $('pairing-wrap').classList.remove('code-ready');
    $('pairing-wrap').classList.remove('pairing-error');
    $('pairing-code').textContent = '';
    // Show the number this code was issued for, right under the code: the
    // code is bound to that number, so if it is not the number of the
    // WhatsApp the user is typing it into, WhatsApp rejects it with
    // "Couldn't link device" every time. Seeing the number here lets the
    // user spot the mismatch instead of guessing.
    $('pairing-steps').textContent = 'This code is for +' + phoneNumber + ' — enter it in the WhatsApp on that number: WhatsApp → ⋮ menu → Linked devices → Link with phone number instead.';
    $('btn-pairing-refresh').style.display = 'none';
    $('btn-pairing-change-number').style.display = 'none';
    $('qr-status').textContent = 'Requesting your pairing code…';
    $('qr-modal').classList.remove('hidden');
    setupConnectModal(channel, slot, (acct) => { if (acct.pairingCode) showPairingCode(acct.pairingCode); });
  } else {
    $('pairing-wrap').classList.add('hidden');
    $('tg-code-wrap').classList.remove('hidden');
    $('tg-code').value = '';
    $('tg-pass').value = '';
    $('tg-pass-row').classList.add('hidden');
    $('tg-code-err').textContent = '';
    $('btn-tg-verify').disabled = true;
    $('qr-status').textContent = 'Sending your login code…';
    $('qr-modal').classList.remove('hidden');
    setupConnectModal(channel, slot, (acct) => { if (acct.phoneCodeSent) enableTgCodeForm(); });
  }
}
// Pairing code arrival (SSE + poll share this path): the code fades/scales
// in over the skeleton, exactly like the QR image does. Re-showing the
// same code is a no-op (no flicker on repeated polls).
function showPairingCode(code) {
  const el = $('pairing-code');
  if (!code || el.textContent === code) return;
  el.textContent = code;
  $('pairing-wrap').classList.add('code-ready');
  $('qr-status').textContent = 'Enter this code in WhatsApp — it expires in about 2 minutes.';
  $('btn-pairing-refresh').style.display = '';
}
// Telegram's code is on its way: enable the entry form.
function enableTgCodeForm() {
  if (!$('btn-tg-verify').disabled) return;
  $('btn-tg-verify').disabled = false;
  $('qr-status').textContent = 'Code sent — enter the 5-digit code from Telegram.';
  setTimeout(() => $('tg-code').focus(), 50);
}

// ---------------- Meta OAuth ----------------
async function startMetaOAuth() {
  let res;
  try {
    res = await api(`/api/clients/${state.clientId}/connectors/messenger/oauth/start`);
  } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
  if (!res.url) return toast('Could not start: no URL returned', 'err');
  window.open(res.url, '_blank', 'width=640,height=720');
  const t = setInterval(async () => {
    try {
      const s = await api(`/api/clients/${state.clientId}/connectors`);
      if (s.messenger && s.messenger.status === 'connected') {
        clearInterval(t); clearTimeout(kill);
        if (state.view === 'settings') loadConnectors();
      }
    } catch {}
  }, 3000);
  const kill = setTimeout(() => clearInterval(t), 180000);
}
async function maybeShowMetaPicker() {
  if (!location.hash.startsWith('#meta-pick')) return;
  const pid = new URLSearchParams(location.hash.split('?')[1] || '').get('pid');
  history.replaceState(null, '', location.pathname);
  if (!pid) return;
  let res;
  try { res = await api(`/api/meta/oauth/pending/${pid}`); }
  catch { return toast('Could not load pages — please try again.', 'err'); }
  if (res.error || !res.pages || !res.pages.length) {
    toast(res.error || 'Connection session expired — please try again.', 'err');
    return;
  }
  $('meta-pick-list').innerHTML = res.pages.map(p =>
    `<button class="pick-btn" data-pick-page="${esc(p.id)}">
      <div class="pn">${esc(p.name)}</div><div class="pi">Page ID ${esc(p.id)}</div>
    </button>`).join('');
  $('meta-pick-modal').classList.remove('hidden');
  document.querySelectorAll('[data-pick-page]').forEach(b => b.onclick = async () => {
    try {
      const r = await api('/api/meta/oauth/pick', {
        method: 'POST', body: JSON.stringify({ pid, pageId: b.dataset.pickPage }),
      });
      $('meta-pick-modal').classList.add('hidden');
      toast(`Connected: ${r.page}` + (r.instagram ? ` + Instagram @${r.instagram}` : ''), 'ok');
      if (state.view === 'settings') loadConnectors();
    } catch (e) { toast('Could not connect: ' + e.message, 'err'); }
  });
}
