// Tectobox frontend — views/guide.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- guide / documentation ----------------
const GUIDES = [
  {
    id: 'start', icon: 'zap', title: 'Your first 5 minutes',
    sub: 'Do these 3 things and Tectobox starts working for you',
    steps: [
      { t: 'Connect WhatsApp', d: 'Go to Connect Channels → WhatsApp → Add account, then scan the QR code with your business phone. New chats will appear in your Inbox automatically.', img: '/img/guide-connect.png?v=20261006c', go: ['Connect WhatsApp', () => gotoSettings('channels')] },
      { t: 'Add your products', d: 'Go to My Products → Add product. Enter the name, price and a short description. The AI uses this to answer "how much?" questions.', img: '/img/guide-products.png?v=20261006c', go: ['Add a product', () => showView('products')] },
      { t: 'Teach the AI', d: 'Go to Teach the AI → add your delivery rules, payment methods and common answers. Anything you write here, the AI will know.', img: '/img/guide-teach.png?v=20261006c', go: ['Teach the AI', () => gotoSettings('kb')], req: 'knowledge' },
    ]
  },
  {
    id: 'inbox', icon: 'inbox', title: 'Replying to chats',
    sub: 'Every customer message lands here',
    steps: [
      { t: 'Open the Inbox tab', d: 'Newest conversations are on top. The colored dot shows the channel — green WhatsApp, blue Telegram, purple website chat.', img: '/img/guide-inbox.png?v=20261006c' },
      { t: 'Tap a conversation', d: 'You see the full chat history plus the customer\'s profile on the side. Type in the box at the bottom and press send — just like any chat app.' },
      { t: 'Filter by channel', d: 'Tap the "Filter by channel" button at the top to show only WhatsApp, only Telegram, or only website chats. Tap the magnifier to search any conversation.' },
      { t: 'Hand icon = needs you', d: 'When a chat needs a human, tap the hand icon at the top. The AI will stay quiet on those chats until you turn it off.' },
    ]
  },
  {
    id: 'leads', icon: 'chart', title: 'Understanding Leads',
    sub: 'Who is ready to buy?',
    steps: [
      { t: 'Open the Leads tab', d: 'Tectobox watches every chat and lists people who showed buying interest — with a score from 0 to 100.', img: '/img/guide-leads.png?v=20261006c' },
      { t: 'Read the score', d: 'Above 70 = Hot (reply now). 40–70 = Warm (follow up soon). Below 40 = Cold (let the AI nurture them).' },
      { t: 'Tap a lead', d: 'See what they want, the suggested next action, and one-tap buttons to message or call them.' },
    ]
  },
  {
    id: 'widget', icon: 'sun', title: 'Chat on your website',
    sub: 'Let visitors talk to your AI',
    steps: [
      { t: 'Open Chat Widget Style', d: 'Open Chat Widget Style in the sidebar (under WORKSPACE). Pick colors and write your greeting message.', img: '/img/guide-widget.png?v=20261006c', go: ['Open widget style', () => gotoSettings('appearance')] },
      { t: 'Copy the code', d: 'Go to Connect Channels → Webchat → Copy embed code. Paste it on your website before </body>. Done — visitors can now chat with your AI.' },
    ]
  },
];
function renderGuide() {
  $('guide-list').innerHTML = GUIDES.map(g => `
    <div class="card guide-card fade-in">
      <div class="guide-head">
        <span class="guide-ic">${ICONS[g.icon] || ''}</span>
        <div><div class="guide-title">${esc(g.title)}</div><div class="muted small">${esc(g.sub)}</div></div>
      </div>
      <div class="guide-steps">
        ${g.steps.map((s, i) => ({ s, i })).filter(({ s }) => !s.req || hasFeature(s.req)).map(({ s, i }, n) => `
          <div class="guide-step">
            <span class="guide-num">${n + 1}</span>
            <div class="guide-body">
              <div class="guide-step-t">${esc(s.t)}</div>
              <div class="guide-step-d">${esc(s.d)}</div>
              ${s.img ? `<span class="guide-img-wrap"><img class="guide-img" src="${s.img}" alt="${esc(s.t)}" loading="lazy"><span class="guide-img-num">${n + 1}</span></span>` : ''}
              ${s.go ? `<button class="btn-soft guide-go" data-g="${g.id}" data-s="${i}">${esc(s.go[0])} →</button>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`).join('');
  document.querySelectorAll('.guide-go').forEach(b =>
    b.onclick = () => {
      const g = GUIDES.find(x => x.id === b.dataset.g);
      const fn = g && g.steps[+b.dataset.s].go && g.steps[+b.dataset.s].go[1];
      if (fn) fn();
    });
}

// ---------------- get started checklist (first-time users) ----------------
function dismissOnboarding() {
  try { localStorage.setItem('tectonic-onboard-hide', '1'); } catch {}
  $('gs-overlay').classList.add('hidden');
}
async function renderGetStarted() {
  const el = $('get-started');
  const ov = $('gs-overlay');
  // ?onboard=1 forces the popup (for testing / demo) — bypasses dismissal + completion.
  let force = false;
  try { force = new URLSearchParams(location.search).get('onboard') === '1'; } catch {}
  try { if (!force && localStorage.getItem('tectonic-onboard-hide') === '1') { ov.classList.add('hidden'); return; } } catch {}
  if (!el || (state.me && isAdmin(state.me.role))) { if (ov) ov.classList.add('hidden'); return; }
  let channels = 0, products = 0, docs = 0;
  try {
    const [st, pr, kb] = await Promise.all([
      api('/api/status').catch(() => ({})),
      api('/api/products').catch(() => []),
      api(`/api/clients/${state.clientId}/knowledge`).catch(() => []),
    ]);
    const plats = (st && st.platforms) || {};
    channels = Object.values(plats).filter(p => p && (p.status === 'connected' || (p.accounts || []).some(a => a.status === 'connected'))).length;
    products = Array.isArray(pr) ? pr.length : (pr.products || []).length;
    docs = Array.isArray(kb) ? kb.length : 0;
  } catch {}
  const steps = [
    { done: channels > 0, t: 'Connect a channel', s: channels > 0 ? 'Connected ✓' : 'Link WhatsApp or Telegram', go: () => gotoSettings('channels') },
    { done: products > 0, t: 'Add your products', s: products > 0 ? products + ' added ✓' : 'What do you sell?', go: () => showView('products') },
    { done: docs > 0, t: 'Teach the AI', s: docs > 0 ? docs + ' taught ✓' : 'Prices, policies, FAQs', go: () => gotoSettings('kb'), req: 'knowledge' },
  ].filter(x => !x.req || hasFeature(x.req));
  const doneCount = steps.filter(x => x.done).length;
  if ((!steps.length || doneCount === steps.length) && !force) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  el.innerHTML = `
    <button class="gs-close" id="gs-close" aria-label="Close">×</button>
    <div class="gs-head">
      <div><div class="gs-title">Get started</div><div class="muted small">${doneCount} of ${steps.length} done — finish setup and you're live</div></div>
      <div class="gs-bar"><span style="width:${steps.length ? doneCount / steps.length * 100 : 0}%"></span></div>
    </div>
    ${steps.map((x, i) => `
      <button class="gs-step ${x.done ? 'done' : ''}" data-gs="${i}">
        <span class="gs-check">${x.done ? '✓' : (i + 1)}</span>
        <span class="gs-tx"><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span>
        ${x.done ? '' : '<span class="muted">→</span>'}
      </button>`).join('')}`;
  el.querySelectorAll('[data-gs]').forEach(b =>
    b.onclick = () => { const st = steps[+b.dataset.gs]; if (!st.done) { dismissOnboarding(); st.go(); } });
  $('gs-close').onclick = dismissOnboarding;
}
