// Tectobox frontend — lib/sse.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- live updates ----------------
function connectSSE() {
  if (window._es) { try { window._es.close(); } catch {} }
  const es = new EventSource('/api/events');
  window._es = es;
  es.onmessage = async (e) => {
    try {
      const evt = JSON.parse(e.data);
      if (evt.type === 'message') {
        if (!evt.outbound) {
          playInboundChime();
        }
        // Preserve the list's scroll position across the refresh.
        const cl = $('conv-list');
        const slTop = cl ? cl.scrollTop : 0;
        await loadConversations(true);
        if (cl) cl.scrollTop = slTop;
        if (evt.conversation && evt.conversation.id === state.activeId) {
          if (evt.outbound) {
            // AI/operator reply landed → append it, warmth indicator goes away.
            const m = evt.outbound;
            if (!state.messages.some(x => x.id === m.id)) state.messages.push(m);
            appendMessage(m);
          } else {
            // Customer wrote → pull the new inbound(s), show "AI is replying…".
            try {
              const fresh = await api(`/api/conversations/${state.activeId}/messages`);
              const seen = new Set(state.messages.map(x => x.id));
              for (const m of fresh) {
                if (!seen.has(m.id)) { state.messages.push(m); appendMessage(m); }
              }
            } catch {}
            showAiThinking(state.activeId);
          }
          const conv = state.conversations.find(c => c.id === state.activeId);
          if (conv) { conv.unread_count = 0; renderConvList(); }
        }
      } else if (evt.type === 'payment:received') {
        playPaymentChime();
        updatePaymentBadge((state.pendingPaymentsCount || 0) + 1);
        const p = evt.payment || {};
        toast(`New payment claim: ${(p.method || 'bKash').toUpperCase()} ৳${p.amount || 0} (TrxID: ${p.transaction_id || ''})`, 'ok');
        if (state.paymentsModalOpen) {
          loadPayments();
          loadPaymentStats();
        }
      } else if (evt.type === 'payment:updated') {
        loadPaymentStats();
        if (state.paymentsModalOpen) {
          loadPayments();
        }
      } else if (evt.type === 'qr') {
        // QR arrivals belong to QR mode only — in phone mode the modal
        // shows the pairing code / code entry instead.
        if (String(evt.clientId) === String(state.clientId) && evt.channel === state.qrChannel
          && (evt.slot || 'default') === (state.qrSlot || 'default') && state.qrMethod !== 'phone') {
          setQrImage(evt.dataUrl);
        }
      } else if (evt.type === 'pairing_code') {
        if (String(evt.clientId) === String(state.clientId) && evt.channel === state.qrChannel
          && (evt.slot || 'default') === (state.qrSlot || 'default') && state.qrMethod === 'phone') {
          showPairingCode(evt.code);
        }
      } else if (evt.type === 'pairing_error') {
        if (String(evt.clientId) === String(state.clientId) && evt.channel === state.qrChannel
          && (evt.slot || 'default') === (state.qrSlot || 'default') && state.qrMethod === 'phone') {
          $('qr-status').textContent = evt.error || 'Could not request a pairing code.';
          // Hide the empty skeleton and offer both ways out: retry the same
          // number, or change it (the usual cause is a wrong number).
          $('pairing-wrap').classList.add('pairing-error');
          $('btn-pairing-refresh').style.display = '';
          $('btn-pairing-change-number').style.display = '';
        }
      } else if (evt.type === 'tg_code_sent') {
        if (String(evt.clientId) === String(state.clientId) && evt.channel === state.qrChannel
          && (evt.slot || 'default') === (state.qrSlot || 'default') && state.qrMethod === 'phone') {
          enableTgCodeForm();
        }
      } else if (evt.type === 'tg_code_error') {
        if (String(evt.clientId) === String(state.clientId) && evt.channel === state.qrChannel
          && (evt.slot || 'default') === (state.qrSlot || 'default') && state.qrMethod === 'phone') {
          $('tg-code-err').textContent = evt.error || 'Something went wrong.';
          $('btn-tg-verify').disabled = false;
          $('qr-status').textContent = 'Code sent — enter the 5-digit code from Telegram.';
        }
      } else if (evt.type === 'tg_password_needed') {
        if (String(evt.clientId) === String(state.clientId) && evt.channel === state.qrChannel
          && (evt.slot || 'default') === (state.qrSlot || 'default') && state.qrMethod === 'phone') {
          $('tg-pass-row').classList.remove('hidden');
          $('tg-code-err').textContent = 'Two-step verification is on — enter your Telegram password too.';
          setTimeout(() => $('tg-pass').focus(), 50);
        }
      } else if (evt.type === 'channel_status' || evt.type === 'connectors') {
        const cid = evt.clientId != null ? String(evt.clientId) : null;
        if (!cid || cid === String(state.clientId)) {
          if ((evt.status === 'connected' || evt.type === 'connectors') && evt.channel === state.qrChannel
            && (evt.slot || 'default') === (state.qrSlot || 'default')) {
            if (state.qrClose) state.qrClose(); else { $('qr-modal').classList.add('hidden'); state.qrChannel = null; state.qrSlot = null; }
          }
          if (state.view === 'settings') loadConnectors();
          if (state.view === 'inbox') renderInboxEmpty();
        }
        if (state.view === 'admin') loadAdmin();
      } else if (evt.type === 'access_changed') {
        // License/access sync: the admin just changed what a workspace may
        // do (license assigned/paused/cancelled, AI paused, suspended…).
        // Only the affected workspace's own client acts on it — the admin
        // panel has its own refresh and must never self-logout from this.
        const isAdm = !state.me || isAdmin(state.me.role);
        const notOurs = evt.clientId != null && String(evt.clientId) !== String(state.clientId);
        if (!isAdm && !notOurs) {
          try {
            if (evt.access) state.access = evt.access;
            else state.access = await api('/api/client/access');
          } catch { try { state.access = await api('/api/client/access'); } catch {} }
          if (state.access && state.access.suspended) {
            // Workspace switched off: the session is dead server-side too.
            toast('This workspace has been suspended by the platform admin.', 'err');
            try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
            location.href = '/app';
            return;
          }
          applyAccessGating();
          renderNav();
          markActiveNav();
          toast('Your plan was updated — features refreshed.', '');
        }
      } else if (evt.type === 'broadcast_progress') {
        if (state.view === 'broadcast') renderBroadcast();
      } else if (evt.type === 'lead') {
        if (String(evt.clientId) === String(state.clientId)) {
          if (state.view === 'leads') loadLeads();
          await loadLeads(true);
          const conv = state.conversations.find(c => c.id === state.activeId);
          if (conv) renderCustomerTab(conv);
        }
      } else if (evt.type === 'comment') {
        if (String(evt.clientId) === String(state.clientId) && $('ca-activity')) {
          loadCommentActivity();
        }
      }
    } catch { /* ignore malformed */ }
  };
  es.onerror = () => { es.close(); window._es = null; setTimeout(connectSSE, 5000); };
}
