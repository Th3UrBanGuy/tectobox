// Tectobox frontend — views/inbox.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- Canned Quick Replies & / Slash Commands ----------------
const DEFAULT_QUICK_REPLIES = [
  {
    cmd: '/bkash',
    title: 'bKash Merchant Payment',
    body: 'আমাদের বিকাশ মার্চেন্ট নম্বর: 017XXXXXXXX (Payment অপশন সিলেক্ট করবেন)। পেমেন্ট করে TrxID বা লাস্ট ৪ ডিজিট এখানে জানাবেন।'
  },
  {
    cmd: '/nagad',
    title: 'Nagad Merchant Payment',
    body: 'আমাদের নগদ মার্চেন্ট নম্বর: 018XXXXXXXX (Make Payment অপশন সিলেক্ট করবেন)। পেমেন্ট করে TrxID টি এখানে জানাবেন।'
  },
  {
    cmd: '/delivery',
    title: 'Delivery charges & time',
    body: 'আমাদের ডেলিভারি চার্জ: ঢাকা সিটির ভিতরে ৬০ টাকা, ঢাকা সিটির বাইরে ১২০ টাকা। ২-৩ কার্যদিবসের মধ্যে ডেলিভারি পাবেন ইনশাআল্লাহ।'
  },
  {
    cmd: '/policy',
    title: 'Checking & return policy',
    body: 'পণ্য রিসিভ করার সময় ডেলিভারি ম্যানের সামনে চেক করে নিবেন। কোন সমস্যা থাকলে সাথে সাথে রিটার্ন করতে পারবেন।'
  },
  {
    cmd: '/size',
    title: 'Standard Apparel Size Chart',
    body: 'আমাদের সাইজ চার্ট:\\nM: Chest 38, Length 27\\nL: Chest 40, Length 28\\nXL: Chest 42, Length 29\\nXXL: Chest 44, Length 30'
  },
  {
    cmd: '/confirm',
    title: 'Order confirmation message',
    body: 'ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে। আমরা দ্রুততম সময়ে পার্সেলটি কুরিয়ারে বুক করে ট্র্যাকিং আইডি জানিয়ে দিচ্ছি।'
  }
];

function getStoredQuickReplies() {
  try {
    const raw = localStorage.getItem('tectobox_quick_replies');
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_QUICK_REPLIES;
}

function saveStoredQuickReplies(list) {
  try {
    localStorage.setItem('tectobox_quick_replies', JSON.stringify(list));
  } catch {}
}

function openQuickRepliesModal() {
  const m = $('quickreplies-modal');
  if (!m) return;
  m.classList.remove('hidden');
  renderQuickRepliesModal();
}

function renderQuickRepliesModal() {
  let list = getStoredQuickReplies();
  // A corrupt/legacy localStorage value (non-array) used to crash with
  // "list.map is not a function" — fall back to the defaults.
  if (!Array.isArray(list)) list = DEFAULT_QUICK_REPLIES;
  const box = $('qr-templates-list');
  if (!box) return;
  box.innerHTML = list.map((item, idx) => `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:10px 12px; border-bottom:1px solid var(--line);">
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="slash-cmd">${esc(item.cmd)}</span>
          <b style="font-size:13px; color:var(--ink);">${esc(item.title)}</b>
        </div>
        <div class="muted small" style="margin-top:4px; line-height:1.4;">${esc(item.body)}</div>
      </div>
      <button class="btn-ghost" data-del-qr="${idx}" style="color:var(--red); font-size:14px; padding:4px 8px;">✕</button>
    </div>
  `).join('');

  box.querySelectorAll('[data-del-qr]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.delQr;
      list.splice(idx, 1);
      saveStoredQuickReplies(list);
      renderQuickRepliesModal();
    };
  });
}

function initSlashCommands() {
  const mi = $('msg-input');
  const pop = $('slash-popup');
  if (!mi || !pop) return;

  function updateSlashPopup() {
    const val = mi.value;
    const slashIdx = val.lastIndexOf('/');
    if (slashIdx === -1 || (slashIdx > 0 && val[slashIdx - 1] !== ' ' && val[slashIdx - 1] !== '\n')) {
      pop.classList.add('hidden');
      return;
    }
    const query = val.slice(slashIdx + 1).toLowerCase();
    const list = getStoredQuickReplies();
    const matches = list.filter(item => item.cmd.toLowerCase().includes('/' + query) || item.title.toLowerCase().includes(query));
    if (!matches.length) {
      pop.classList.add('hidden');
      return;
    }
    pop.innerHTML = matches.map((m, i) => `
      <button class="slash-item" data-slash-idx="${i}">
        <span class="slash-cmd">${esc(m.cmd)}</span>
        <span class="slash-desc"><b>${esc(m.title)}</b> — <span class="slash-snippet">${esc(m.body.slice(0, 50))}…</span></span>
      </button>
    `).join('');

    pop.querySelectorAll('[data-slash-idx]').forEach(btn => {
      btn.onclick = () => {
        const item = matches[+btn.dataset.slashIdx];
        const before = val.slice(0, slashIdx);
        mi.value = before + item.body + ' ';
        pop.classList.add('hidden');
        mi.focus();
        autosizeComposer();
        refreshSendBtn();
      };
    });
    pop.classList.remove('hidden');
  }

  mi.addEventListener('input', updateSlashPopup);
  mi.addEventListener('keydown', e => {
    if (e.key === 'Escape') pop.classList.add('hidden');
  });
  document.addEventListener('click', e => {
    if (!pop.contains(e.target) && e.target !== mi) pop.classList.add('hidden');
  });
}

const isMobileView = () => window.matchMedia('(max-width: 900px)').matches;
function closeMobileChat() {
  $('inbox-panes').classList.remove('m-chat-open', 'm-detail-open');
  state.activeId = null;
  renderConvList();
  setComposerEnabled(false);
}
function toggleMobileDetail(open) {
  $('inbox-panes').classList.toggle('m-detail-open', open);
}

// ---------------- client: inbox ----------------
async function loadClientAll() {
  await Promise.all([loadStats(), loadConversations(true), loadProducts(true)]);
  renderCustomerTab(null);
  setComposerEnabled(false);
}
async function loadStats() { /* reserved for future stat display */ }

function renderPlatformChips() {
  const hidden = META_CONNECTORS_VISIBLE ? [] : ['messenger', 'instagram'];
  const all = [{ id: 'all', label: 'All' }, ...Object.entries(PLATFORMS)
    .filter(([id]) => !hidden.includes(id)).map(([id, m]) => ({ id, label: m.label }))];
  const pop = $('filter-pop');
  if (pop) {
    pop.innerHTML = all.map(c => `
      <button class="pop-item ${state.platformFilter === c.id ? 'active' : ''}" data-p="${c.id}" role="menuitem">
        ${c.id !== 'all' ? platDot(c.id) : '<span class="plat-dot" style="background:var(--muted)"></span>'}${esc(c.label)}
        <span class="tick">✓</span>
      </button>`).join('');
    pop.querySelectorAll('.pop-item').forEach(b =>
      b.onclick = (e) => { e.stopPropagation(); state.platformFilter = b.dataset.p; renderPlatformChips(); renderConvList(); loadConversations(true); closeFilterPop(); });
  }
  const dot = $('filter-dot');
  if (dot) dot.classList.toggle('hidden', state.platformFilter === 'all');
  const fb = $('btn-filter');
  if (fb) fb.classList.toggle('on', state.platformFilter !== 'all');
}
function closeFilterPop() { var _p = $('filter-pop'); if (_p) _p.classList.add('hidden'); }

// Generation counter: concurrent loads (boot fires two) can't clobber each other,
// and a failed fetch shows a warm retry state instead of a dead skeleton.
let _convGen = 0;
async function loadConversations(quiet) {
  const gen = ++_convGen;
  const q = new URLSearchParams();
  if (state.platformFilter !== 'all') q.set('platform', state.platformFilter);
  if (state.convQuery) q.set('q', state.convQuery);
  if (!quiet) {
    // Skeleton shimmer while fetching — feels instant, never a blank flash.
    $('conv-list').innerHTML = Array.from({ length: 6 }, () =>
      `<div class="conv-skel"><div class="sk-av"></div><div class="sk-lines"><div class="sk-l1"></div><div class="sk-l2"></div></div></div>`).join('');
  }
  try {
    state.conversations = await api('/api/conversations' + (q.toString() ? '?' + q : ''));
  } catch (e) {
    if (gen !== _convGen) return; // superseded by a newer load
    $('conv-list').innerHTML = `<div class="warm-empty">
      <div class="we-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg></div><b>Couldn't load conversations</b>
      <p>The connection hiccuped. Your chats are safe — let's try again.</p>
      <button class="btn-primary" id="btn-conv-retry" style="margin-top:6px;">Retry</button>
    </div>`;
    $('btn-conv-retry').onclick = () => loadConversations();
    return;
  }
  if (gen !== _convGen) return; // a newer load won the race — don't clobber it
  if (!quiet) state._convAnim = true; // play the staggered entrance once
  renderConvList();
  renderInboxEmpty();
}

function renderConvList() {
  // A non-array payload used to crash the inbox with "list.map is not a
  // function" (same class as the 2026-11-13 KB crash) — degrade to empty.
  let list = Array.isArray(state.conversations) ? state.conversations : [];
  if (state.needsHuman) list = list.filter(c => (c.unread_count || 0) > 0);
  const box = $('conv-list');
  if (!list.length) {
    box.innerHTML = `<div class="conv-empty">
      <div class="conv-empty-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
      <div><b>No conversations yet</b></div>
      <div class="muted small">New chats from WhatsApp, Telegram and your website will appear here.</div>
    </div>`;
    return;
  }
  box.innerHTML = list.map((c, i) => {
    const m = PLATFORMS[c.platform] || {};
    const nm = c.customer_name || m.label || c.platform;
    const unread = c.unread_count > 0;
    // Keep the "AI is replying…" warmth across list re-renders.
    const thinking = state._thinking === c.id;
    // Stagger the entrance — first render only, so re-renders don't replay it.
    const anim = state._convAnim ? ` style="animation-delay:${Math.min(i * 35, 500)}ms"` : '';
    return `<div class="conv-item${state.activeId === c.id ? ' active' : ''}${state._convAnim ? ' conv-enter' : ''}" data-id="${c.id}"${anim}>
      ${convAvatar(c)}
      <div class="conv-main">
        <div class="conv-top">
          <span class="conv-name">${esc(nm)}</span>
          <span class="conv-time${unread ? ' unread-t' : ''}">${relTime(c.last_message_at)}</span>
        </div>
        <div class="conv-sub">
          <span class="conv-prev${unread ? ' unread-p' : ''}${thinking ? ' typing' : ''}">${thinking ? 'AI is replying' : esc(previewText(c.last_message) || '')}</span>
          ${unread ? `<span class="unread">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  state._convAnim = false;
  box.querySelectorAll('.conv-item').forEach(el => el.onclick = () => selectConversation(Number(el.dataset.id)));
}

async function renderInboxEmpty() {
  const empty = $('inbox-empty'), panes = $('inbox-panes');
  // Hide the list panes synchronously when there is nothing to list, BEFORE
  // the connectors fetch resolves — otherwise the Chats toolbar and the
  // "No conversations yet" block flash above/below the banner while the
  // fetch is in flight (2026-11-13: user saw both stacked, "no head or tail").
  // The fetch below only ever un-hides them again when a channel IS connected.
  if (!state.conversations.length) panes.classList.add('hidden');
  let connected = 0;
  try {
    const conns = await api(`/api/clients/${state.clientId}/connectors`);
    connected = Object.values(conns).filter(s => s.status === 'connected').length;
  } catch {}
  if (!state.conversations.length && connected === 0) {
    empty.innerHTML = `<div class="empty-state fade-in">
      <div class="ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 19.5h.01"/></svg></div>
      <h3>No channels connected yet</h3>
      <p>Link your first WhatsApp, Telegram or Messenger account<br>to start receiving customer conversations in this unified inbox.</p>
      <button class="btn-primary" id="btn-goto-connect">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Connect a channel
      </button>
    </div>`;
    $('btn-goto-connect').onclick = () => gotoSettings('channels');
  } else {
    panes.classList.remove('hidden');
    empty.innerHTML = '';
  }
}

async function selectConversation(id) {
  state.activeId = id;
  state.orderLines = {};
  renderConvList();
  try { await api(`/api/conversations/${id}/read`, { method: 'POST' }); } catch {}
  const conv = state.conversations.find(c => c.id === id);
  if (conv) { conv.unread_count = 0; renderConvList(); }
  state.messages = await api(`/api/conversations/${id}/messages`);
  renderChatHeader(conv);
  renderMessages();
  renderCustomerTab(conv);
  renderOrderTab();
  setComposerEnabled(true);
  restoreDraft();
  // Animated entrance: the chat slides in beside the contact.
  const pane = document.querySelector('.chat-pane');
  if (pane) {
    pane.classList.remove('pane-enter');
    void pane.offsetWidth; // restart the animation
    pane.classList.add('pane-enter');
  }
  if (isMobileView()) {
    $('inbox-panes').classList.add('m-chat-open');
    $('inbox-panes').classList.remove('m-detail-open');
  } else {
    $('msg-input').focus();
  }
}

function renderChatHeader(conv) {
  const box = $('chat-header');
  const hb = $('human-banner-slot');
  if (!conv) {
    box.innerHTML = '';
    if (hb) hb.innerHTML = '';
    $('messages').innerHTML = `<div class="warm-empty">
      <div class="we-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><b>Pick a conversation</b>
      <p>Choose someone from the list and you'll be chatting in a second. Every message here is a real person — treat them like a guest.</p>
    </div>`;
    return;
  }
  const m = PLATFORMS[conv.platform] || {};
  const nm = conv.customer_name || m.label || 'Chat';
  const sub = conv.customer_phone ? esc(conv.customer_phone) : esc(m.label || '');
  box.innerHTML = `
    <button class="icon-btn m-back" id="btn-chat-back" aria-label="Back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    ${convAvatar(conv, 'lg')}
    <div style="flex:1; min-width:0;"><div class="nm">${esc(nm)}</div>
    <div class="sub">${sub}</div></div>
    ${conv.needs_human ? '<span class="pill amber" id="badge-needs-human">Needs human</span>' : ''}
    <button class="icon-btn" id="btn-toggle-human" title="${conv.needs_human ? 'Resolve human handover (resume AI)' : 'Flag for human attention (pause AI)'}" style="color:${conv.needs_human ? '#f59e0b' : 'var(--muted)'};">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.9-2.3l-3.4-3.85a2 2 0 0 1 3-2.65L7 15"/></svg>
    </button>
    <button class="icon-btn" id="btn-delete-conv" title="Delete conversation" style="color:var(--muted);">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
    <button class="icon-btn m-info" id="btn-chat-info" aria-label="Details">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>
    </button>`;
  $('btn-chat-back').onclick = closeMobileChat;
  $('btn-chat-info').onclick = () => toggleMobileDetail(!$('inbox-panes').classList.contains('m-detail-open'));
  const btnDeleteConv = $('btn-delete-conv');
  if (btnDeleteConv) {
    btnDeleteConv.onclick = async () => {
      const ok = typeof askConfirm === 'function'
        ? await askConfirm('Delete conversation?', 'This conversation and its messages will be scheduled for permanent deletion in 15 days (recoverable within 15 days).', 'Delete', true)
        : confirm('Delete this conversation? Recoverable within 15 days before permanent deletion.');
      if (!ok) return;
      try {
        await api(`/api/clients/${state.clientId}/conversations/${conv.id}`, { method: 'DELETE' });
        state.conversations = (state.conversations || []).filter(c => c.id !== conv.id);
        state.activeId = null;
        state.messages = [];
        renderChatHeader(null);
        renderConvList();
        toast('Conversation deleted ✓');
      } catch (e) {
        toast('Failed to delete conversation: ' + e.message, 'err');
      }
    };
  }
  const btnToggleHuman = $('btn-toggle-human');
  if (btnToggleHuman) {
    btnToggleHuman.onclick = async () => {
      const nextState = !conv.needs_human;
      try {
        await api(`/api/conversations/${conv.id}/flag`, {
          method: 'POST',
          body: JSON.stringify({ needs_human: nextState })
        });
        conv.needs_human = nextState;
        renderChatHeader(conv);
        renderConvList();
        toast(nextState ? 'Flagged for human assistance ✓' : 'Human handover resolved — AI resumed ✓');
      } catch (e) {
        toast('Failed to update flag: ' + e.message, 'err');
      }
    };
  }
  // Warm handover banner — a human heart is needed here.
  const hbs = $('human-banner-slot');
  if (hbs) {
    hbs.innerHTML = conv.needs_human
      ? `<div class="human-banner"><span class="dot"></span><span><b>${esc(nm.split(' ')[0])}</b> asked for a human — jump in, they'll feel the difference.</span></div>`
      : '';
  }
}

// Toast — warm in-app notices. Never use alert().
function toast(msg, kind) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s, transform .3s'; t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; setTimeout(() => t.remove(), 320); }, 2600);
}

function msgBubble(m) {
  return `<div class="bubble ${m.direction === 'out' ? 'bubble-out' : 'bubble-in'}">
    <div class="txt">${richText(m.text)}</div>
    <span class="ts">${fmtTime(m.created_at)}</span>
  </div>`;
}

// Markdown-lite for chat bubbles: escape first (XSS-safe), then format
// **bold**, * bullets, and line breaks. No raw "**" leaks to the customer.
function richText(t) {
  let h = esc(t || '');
  // bold
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // bullet lines: "* item" or "• item" or "- item" at line start
  h = h.replace(/^(?:\*|•|-)\s+(.+)$/gm, '<span class="md-li">$1</span>');
  // line breaks
  h = h.replace(/\n/g, '<br>');
  return h;
}

function renderMessages() {
  const box = $('messages');
  hideAiThinking();
  if (!state.messages.length) {
    box.innerHTML = `<div class="warm-empty">
      <div class="we-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><b>No messages yet</b>
      <p>Say hello! Your first message will appear here — and the AI will keep the conversation warm when you're away.</p>
    </div>`;
    return;
  }
  let lastDay = '', lastDir = '';
  box.innerHTML = state.messages.map(m => {
    const day = fmtDay(m.created_at);
    const div = day !== lastDay ? `<div class="day-div"><span>${day}</span></div>` : '';
    lastDay = day;
    const grouped = m.direction === lastDir ? ' grouped' : '';
    lastDir = m.direction;
    return `${div}<div class="msg-row ${m.direction === 'out' ? 'out' : ''}${grouped} fade-in" data-mid="${m.id || ''}">${msgBubble(m)}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

// Incremental append — no full re-render, no scroll jump, no animation replay.
function appendMessage(m) {
  const box = $('messages');
  if (!box || document.querySelector(`.msg-row[data-mid="${m.id}"]`)) return; // dedupe
  hideAiThinking();
  const empty = box.querySelector('.warm-empty');
  if (empty) { renderMessages(); return; }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const rows = box.querySelectorAll('.msg-row');
  const lastRow = rows[rows.length - 1];
  const lastDir = lastRow ? (lastRow.classList.contains('out') ? 'out' : 'in') : '';
  const grouped = lastDir === m.direction ? ' grouped' : '';
  const lastDayDiv = [...box.querySelectorAll('.day-div')].pop();
  const day = fmtDay(m.created_at);
  const needDay = !lastDayDiv || lastDayDiv.textContent.trim() !== day;
  const html = `${needDay ? `<div class="day-div"><span>${day}</span></div>` : ''}<div class="msg-row ${m.direction === 'out' ? 'out' : ''}${grouped}" data-mid="${m.id || ''}">${msgBubble(m)}</div>`;
  box.insertAdjacentHTML('beforeend', html);
  if (nearBottom || m.direction === 'out') box.scrollTop = box.scrollHeight;
}

// AI thinking indicator — the human warmth of "she is typing…"
let _thinkTimer = null;
function showAiThinking(convId) {
  if (convId !== state.activeId) return;
  hideAiThinking();
  const box = $('messages');
  if (!box || box.querySelector('.warm-empty')) return;
  box.insertAdjacentHTML('beforeend', `<div class="typing-row" id="ai-thinking">
    <div class="typing-bubble"><i></i><i></i><i></i></div>
    <span class="typing-label">AI is replying…</span>
  </div>`);
  box.scrollTop = box.scrollHeight;
  // Conv-list preview shows the warmth too.
  state._thinking = convId;
  const row = document.querySelector(`.conv-item[data-id="${convId}"] .conv-prev`);
  if (row) { row.classList.add('typing'); row.textContent = 'AI is replying'; }
  _thinkTimer = setTimeout(hideAiThinking, 90000); // safety
}
function hideAiThinking() {
  clearTimeout(_thinkTimer);
  const t = $('ai-thinking');
  if (t) t.remove();
  if (state._thinking) {
    const row = document.querySelector(`.conv-item[data-id="${state._thinking}"] .conv-prev`);
    if (row) row.classList.remove('typing');
    state._thinking = null;
  }
}

async function sendReply() {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeId) return;
  input.value = '';
  clearDraft();
  autosizeComposer();
  // Optimistic: the message appears instantly with a "sending" shimmer.
  const pending = { id: 'pending-' + Date.now(), direction: 'out', text, created_at: new Date().toISOString() };
  appendMessage(pending);
  try {
    const res = await api(`/api/conversations/${state.activeId}/reply`, {
      method: 'POST', body: JSON.stringify({ text }),
    });
    // Swap the optimistic row for the real one.
    const prow = document.querySelector(`.msg-row[data-mid="${pending.id}"]`);
    if (prow) prow.remove();
    // The SSE broadcast may have already delivered this message — dedupe.
    if (!state.messages.some(x => x.id === res.message.id)) state.messages.push(res.message);
    appendMessage(res.message);
    input.focus();
  } catch (e) {
    const prow = document.querySelector(`.msg-row[data-mid="${pending.id}"]`);
    if (prow) prow.remove();
    toast('Could not send — please check your connection and try again.', 'err');
  }
}

// Textarea grows with the message, up to 130px.
function autosizeComposer() {
  const input = $('msg-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 130) + 'px';
}

// Composer drafts persist per conversation (localStorage).
function saveDraft() {
  if (!state.activeId) return;
  try { localStorage.setItem('draft-' + state.activeId, $('msg-input').value); } catch {}
}
function restoreDraft() {
  if (!state.activeId) return;
  try {
    const d = localStorage.getItem('draft-' + state.activeId) || '';
    $('msg-input').value = d;
    autosizeComposer();
    updateSendBtn();
  } catch {}
}
function clearDraft() {
  if (!state.activeId) return;
  try { localStorage.removeItem('draft-' + state.activeId); } catch {}
}

// Global modal behavior: backdrop click closes. (Escape is handled in the
// unified keyboard listener inside initCmdk.)
function initModals() {
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('click', e => {
      if (e.target === bg && bg.id !== 'cmdk-bg') bg.classList.add('hidden');
    });
  });
}

// Offline banner.
function initOffline() {
  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.className = 'hidden';
  banner.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg> You are offline — messages will send when you reconnect.';
  document.body.prepend(banner);
  const upd = () => banner.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', upd);
  window.addEventListener('offline', upd);
  upd();
}

// The send button only comes alive when there's something to send.
function refreshSendBtn() {
  const hasText = $('msg-input').value.trim().length > 0;
  $('btn-send').disabled = !state.activeId || !hasText;
}
// Composer is only usable when a conversation is selected — otherwise the
// input, send button and quick replies stay visibly disabled.
function setComposerEnabled(on) {
  $('msg-input').disabled = !on;
  document.querySelectorAll('#quick-replies button').forEach(b => b.disabled = !on);
  document.querySelector('.composer').classList.toggle('composer-idle', !on);
  refreshSendBtn();
}
function renderQuickReplies() {
  const items = ['Share catalog', 'Check stock', 'Delivery info'];
  const idle = !state.activeId;
  $('quick-replies').innerHTML = items.map(q => `<button data-q="${esc(q)}" ${idle ? 'disabled' : ''}>${esc(q)}</button>`).join('');
  document.querySelectorAll('#quick-replies button').forEach(b =>
    b.onclick = async () => { $('msg-input').value = await quickReplyText(b.dataset.q); $('msg-input').focus(); });
}

// Quick replies insert REAL content, not the button label.
async function quickReplyText(which) {
  try {
    if (which === 'Share catalog' || which === 'Check stock') {
      if (!state.products) state.products = await api('/api/products');
      const ps = (state.products || []).slice(0, 12);
      if (!ps.length) return which === 'Share catalog'
        ? 'Our catalog is being updated — please ask about any product!'
        : 'Stock info coming right up — which product are you asking about?';
      if (which === 'Share catalog')
        return 'Our catalog:\n\n' + ps.map(p => `• ${p.name} — ৳${Number(p.price_bdt).toLocaleString()}`).join('\n');
      return 'Stock update:\n\n' + ps.map(p => `• ${p.name} — ${(p.stock || 0) > 0 ? `In stock (${p.stock} pcs)` : 'Out of stock'}`).join('\n');
    }
    if (which === 'Delivery info') {
      if (!state.knowledge) state.knowledge = await api(`/api/clients/${state.clientId}/knowledge`);
      const ship = (state.knowledge || []).find(k => (k.category || '') === 'shipping');
      if (ship && ship.content) return ship.content;
      return 'Delivery charge: ৳60 inside Dhaka (24–48 hours), ৳120 outside Dhaka (3–5 working days). Cash on delivery available all over Bangladesh.';
    }
  } catch { /* fall through to label */ }
  return which + ' ';
}

// ---------------- client: customer / products / order tabs ----------------
function leadForConv(conv) {
  if (!conv) return null;
  return (state.leads || []).find(l => l.platform === conv.platform && String(l.platform_user_id) === String(conv.platform_user_id)) || null;
}
async function renderCustomerTab(conv) {
  const box = $('tab-customer');
  if (!conv) { box.innerHTML = '<div class="tbl-empty">Select a conversation</div>'; return; }
  const m = PLATFORMS[conv.platform] || {};
  let orders = [];
  try { orders = await api(`/api/conversations/${conv.id}/orders`); } catch {}
  const lead = leadForConv(conv);
  const status = lead ? lead.status : 'lead';
  const score = lead && lead.score != null ? Math.round(lead.score) : null;
  const tempColor = lead && lead.temperature === 'hot' ? '#ef4444' : lead && lead.temperature === 'warm' ? '#f59e0b' : '#3b82f6';
  const ring = (() => {
    const r = 26, c = 2 * Math.PI * r;
    const pct = score != null ? score : 0;
    const off = c * (1 - pct / 100);
    return `<div class="score-ring">
      <svg width="64" height="64"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--line)" stroke-width="6"/>
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="${tempColor}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
      <div class="sc-val">${score != null ? score : '–'}</div></div>
      <div class="sc-lb">${score != null ? 'Lead score' : 'No score yet'}</div>`;
  })();
  box.innerHTML = `
    <div class="cust-hero">
      ${convAvatar(conv, 'lg')}
      <div class="nm">${esc(conv.customer_name || m.label)}</div>
      <div class="sub">${esc(conv.customer_phone || m.label || '')}</div>
      ${ring}
    </div>
    <div class="kv"><span class="k">Phone</span><span class="v">${esc(conv.customer_phone || (lead && lead.phone) || '—')}</span></div>
    <div class="kv"><span class="k">Email</span><span class="v">${esc((lead && lead.email) || '—')}</span></div>
    <div class="kv"><span class="k">Platform ID</span><span class="v" style="font-family:ui-monospace,monospace; font-size:11.5px;">${esc(conv.platform_user_id)}</span></div>
    <div class="kv"><span class="k">Lead status</span><span class="v">${leadPill(status)}</span></div>
    <div id="cust-fraud-box" style="margin:10px 0;"></div>
    ${status !== 'confirmed' ? `<button class="btn-soft mt8" id="btn-advance-cust" style="width:100%; justify-content:center;">Advance to ${LEAD_NEXT[status]} →</button>` : ''}
    <div style="font-weight:800; color:var(--ink); font-size:13.5px; margin:16px 0 8px;">Order history (${orders.length})</div>
    ${orders.length ? orders.map(o => {
      let items = [];
      try { items = typeof o.items_json === 'string' ? JSON.parse(o.items_json) : (o.items_json || []); } catch {}
      const dc = Number(o.delivery_charge_bdt) || 0;
      const advReq = Number(o.advance_required_bdt) || 0;
      const advPaid = Number(o.advance_paid_bdt) || 0;
      const grandTotal = Number(o.total_bdt) + dc;
      const pctPaid = grandTotal > 0 ? Math.round((advPaid / grandTotal) * 100) : 0;
      const payCls = o.payment_status === 'paid' ? 'green' : o.payment_status === 'partial' ? 'amber' : 'gray';
      const isBooked = o.courier_status === 'booked';
      return `<div class="prod-row" style="flex-direction:column; align-items:stretch; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="inf"><div class="nm">#${o.id} · ${esc(o.status)}</div>
          <div class="meta">${items.map(i => `${i.qty}x ${esc(i.name || i.sku)}`).join(', ')}</div>
          <div class="meta">${fmtDT(o.created_at)}</div></div>
          <div style="text-align:right;">
            <div style="font-weight:800; color:var(--ink); font-size:14px;">৳${grandTotal.toLocaleString('en-US')}</div>
            ${dc ? `<div class="meta">incl. ৳${dc} delivery</div>` : ''}
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="pill ${payCls}">${esc(o.payment_status || 'pending')}</span>
          ${o.transaction_id ? `<span class="small muted" style="font-family:ui-monospace,monospace;">TrxID: ${esc(o.transaction_id)}</span>` : ''}
          <span style="margin-left:auto;" class="small muted">৳${advPaid.toLocaleString('en-US')} / ৳${grandTotal.toLocaleString('en-US')} (${pctPaid}%)</span>
        </div>
        <div style="height:6px; background:var(--hover); border-radius:99px; overflow:hidden;">
          <div style="height:100%; width:${pctPaid}%; background:var(--accent-grad); border-radius:99px; transition:width .4s var(--ease);"></div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; padding-top:6px; border-top:1px dashed var(--line);">
          <span class="pill ${isBooked ? 'green' : 'amber'}">${isBooked ? esc(o.courier_tracking_code || 'Booked') : 'Unbooked'}</span>
          <div style="display:flex; gap:6px;">
            ${!isBooked ? `<button class="mini-btn" data-cust-book="${o.id}">Book courier</button>` : ''}
            <button class="mini-btn" data-cust-print="${o.id}">Label</button>
          </div>
        </div>
      </div>`;
    }).join('') : '<div class="small muted">No orders yet</div>'}`;

  // Check fraud / return risk asynchronously
  const ph = conv.customer_phone || (lead && lead.phone);
  if (ph) {
    api('/api/courier/fraud-check?phone=' + encodeURIComponent(ph))
      .then(f => {
        const fb = $('cust-fraud-box');
        if (!fb) return;
        const pCls = f.risk_level === 'high' ? 'red' : f.risk_level === 'medium' ? 'amber' : 'green';
        const icSvg = f.risk_level === 'high'
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
        fb.innerHTML = `
          <div style="padding:10px 12px; border-radius:12px; background:var(--active); border:1px solid var(--line); font-size:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-weight:700; color:var(--ink); display:flex; align-items:center; gap:6px;">
                <span>${icSvg}</span> Courier Reliability
              </span>
              <span class="pill ${pCls}">${f.success_rate}% Success</span>
            </div>
            <div class="muted small">${esc(f.risk_label)}</div>
          </div>
        `;
      }).catch(() => {});
  }

  box.querySelectorAll('[data-cust-book]').forEach(btn => {
    btn.onclick = () => {
      const o = orders.find(x => String(x.id) === btn.dataset.custBook);
      if (o) openCourierBookModal(o);
    };
  });
  box.querySelectorAll('[data-cust-print]').forEach(btn => {
    btn.onclick = () => printThermalShippingLabel(btn.dataset.custPrint);
  });

  const adv = $('btn-advance-cust');
  if (adv && lead) adv.onclick = () => advanceLead(lead.id);
}
async function advanceLead(leadId) {
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead || lead.status === 'confirmed') return;
  await api(`/api/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify({ status: LEAD_NEXT[lead.status] }) });
  await loadLeads(true);
  const conv = state.conversations.find(c => c.id === state.activeId);
  renderCustomerTab(conv || null);
}

async function loadProducts(quiet) {
  state.products = await api('/api/products' + (state.productQuery ? '?q=' + encodeURIComponent(state.productQuery) : ''));
  if (!quiet) { renderProductGrid(); renderProductList(); renderOrderProducts(); }
}
function productMeta(p) {
  return `${esc(p.sku)} · ${Number(p.price_bdt).toLocaleString('en-US')} BDT · stock ${p.stock}`;
}
function renderProductList() {
  // right-pane tab: click inserts a quote line into the reply box
  $('product-list').innerHTML = state.products.map(p => `
    <div class="prod-row" data-quote="${p.id}" style="cursor:pointer;" title="Insert into reply">
      <div class="inf"><div class="nm">${esc(p.name)}</div><div class="meta">${productMeta(p)}</div></div>
    </div>`).join('') || '<div class="small muted">No products found</div>';
  document.querySelectorAll('#product-list [data-quote]').forEach(el => el.onclick = () => {
    const p = state.products.find(x => String(x.id) === el.dataset.quote);
    if (!p) return;
    $('msg-input').value += `• ${p.name} — ${Number(p.price_bdt).toLocaleString('en-US')} BDT\n`;
    $('msg-input').focus();
  });
}
function renderOrderProducts() {
  // order builder product picker
  const box = $('order-products');
  if (!box) return;
  box.innerHTML = state.products.map(p => `
    <div class="prod-row"><div class="inf"><div class="nm">${esc(p.name)}</div><div class="meta">${productMeta(p)}</div></div>
      <button class="mini-btn" data-addline="${p.id}">+ Add</button></div>`).join('')
    || '<div class="small muted">No products</div>';
  box.querySelectorAll('[data-addline]').forEach(b => b.onclick = () => {
    const id = b.dataset.addline;
    state.orderLines[id] = (state.orderLines[id] || 0) + 1;
    renderOrderTab();
  });
}
function renderOrderTab() {
  const box = $('order-lines');
  const ids = Object.keys(state.orderLines);
  box.innerHTML = ids.length ? ids.map(id => {
    const p = state.products.find(x => String(x.id) === String(id));
    if (!p) return '';
    const qty = state.orderLines[id];
    return `<div class="prod-row">
      <div class="inf"><div class="nm">${esc(p.name)}</div><div class="meta">${Number(p.price_bdt).toLocaleString('en-US')} BDT each</div></div>
      <button class="qty-btn" data-dec="${id}">−</button>
      <span style="font-weight:800; width:24px; text-align:center;">${qty}</span>
      <button class="qty-btn" data-inc="${id}">+</button></div>`;
  }).join('') : '<div class="small muted" style="margin-bottom:10px;">No items yet — add from the list below.</div>';
  box.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => { state.orderLines[b.dataset.inc]++; renderOrderTab(); });
  box.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
    const id = b.dataset.dec;
    if (--state.orderLines[id] <= 0) delete state.orderLines[id];
    renderOrderTab();
  });
  const total = ids.reduce((s, id) => {
    const p = state.products.find(x => String(x.id) === String(id));
    return s + (p ? Number(p.price_bdt) * state.orderLines[id] : 0);
  }, 0);
  $('order-total').textContent = Number(total).toLocaleString('en-US') + ' BDT';
}
async function createOrder() {
  if (state.creatingOrder) return;
  const ids = Object.keys(state.orderLines || {});
  if (!ids.length || !state.activeId) { $('order-msg').textContent = 'Pick a conversation and add items first.'; return; }
  const btn = $('btn-create-order');
  if (btn) btn.disabled = true;
  state.creatingOrder = true;
  const items = ids.map(id => {
    const p = (state.products || []).find(x => String(x.id) === String(id));
    return {
      sku: p ? p.sku : `ITEM-${id}`,
      name: p ? p.name : 'Product Item',
      price_bdt: p ? Number(p.price_bdt || 0) : 0,
      qty: state.orderLines[id] || 1,
    };
  });
  try {
    const res = await api('/api/orders', { method: 'POST', body: JSON.stringify({ conversation_id: state.activeId, items }) });
    $('order-msg').textContent = `Order #${res.order.id} created — ${Number(res.order.total_bdt).toLocaleString('en-US')} BDT. Summary posted in chat.`;
    state.orderLines = {};
    renderOrderTab();
    state.messages = await api(`/api/conversations/${state.activeId}/messages`);
    renderMessages();
  } catch (e) { $('order-msg').textContent = 'Error: ' + e.message; }
  finally {
    state.creatingOrder = false;
    if (btn) btn.disabled = false;
  }
}
function switchSideTab(name) {
  document.querySelectorAll('.side-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-customer').classList.toggle('hidden', name !== 'customer');
  $('tab-products').classList.toggle('hidden', name !== 'products');
  $('tab-order').classList.toggle('hidden', name !== 'order');
  if (name === 'products') renderProductList();
  if (name === 'order') { renderOrderProducts(); renderOrderTab(); }
}
