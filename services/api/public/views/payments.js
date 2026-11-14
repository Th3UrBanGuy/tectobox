// Tectobox frontend — views/payments.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- Live Payments Hub & Real-time Verification ----------------
let currentPaymentsTab = 'pending';

function updatePaymentBadge(count) {
  state.pendingPaymentsCount = Math.max(0, count);
  document.querySelectorAll('.badge-pending-count').forEach(badge => {
    if (state.pendingPaymentsCount > 0) {
      badge.textContent = state.pendingPaymentsCount > 99 ? '99+' : state.pendingPaymentsCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

async function loadPaymentStats() {
  try {
    const res = await api('/api/payments/stats');
    if (!res) return;
    updatePaymentBadge(res.pending || 0);
    const pEl = $('pay-stat-pending'); if (pEl) pEl.textContent = res.pending;
    const vEl = $('pay-stat-verified'); if (vEl) vEl.textContent = res.verified;
    const volEl = $('pay-stat-volume'); if (volEl) volEl.textContent = '৳' + Number(res.verified_volume_today || 0).toLocaleString();
    const dEl = $('pay-stat-duplicates'); if (dEl) dEl.textContent = res.duplicates;
    const tabCnt = $('tab-cnt-pending'); if (tabCnt) tabCnt.textContent = res.pending;
  } catch {}
}

async function loadPayments(tab = currentPaymentsTab) {
  currentPaymentsTab = tab;
  const listEl = $('payments-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="text-align:center;padding:24px;" class="muted small">Loading payments…</div>';

  try {
    const res = await api(`/api/payments?status=${tab}`);
    const payments = res.payments || [];

    if (!payments.length) {
      const emptyLabels = {
        pending: 'No pending payments waiting for verification',
        verified: 'No verified payments recorded yet.',
        rejected: 'No rejected payments.',
        all: 'No payment records found.'
      };
      listEl.innerHTML = `
        <div class="empty-state-box" style="text-align:center;padding:40px 16px;background:var(--card);border-radius:14px;border:1px dashed var(--line);">
          <div style="margin-bottom:8px;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><circle cx="7" cy="15" r="1"/></svg></div>
          <div style="font-weight:700;color:var(--ink);font-size:15px;">${emptyLabels[tab] || 'No payments'}</div>
          <p class="muted small" style="margin:4px 0 0;">Customer payments from WhatsApp, Webchat and other channels will appear here in real-time.</p>
        </div>`;
      return;
    }

    listEl.innerHTML = payments.map(p => {
      const isDup = !!p.duplicate_flag;
      const method = (p.method || 'bkash').toLowerCase();
      const timeStr = timeAgo(new Date(p.created_at).getTime());
      const custName = p.customer_name || 'Customer';
      const custPhone = p.customer_phone || '';
      const orderTotal = p.order_total ? ` · Order #ORD-${p.order_id || p.id} (৳${p.order_total})` : '';

      let actionsHtml = '';
      if (p.status === 'pending') {
        actionsHtml = `
          <button class="btn-primary btn-sm btn-verify-pay" data-pay-id="${p.id}" style="background:#10b981;box-shadow:none;">
            Verify &amp; Confirm
          </button>
          <button class="btn-danger-soft btn-sm btn-reject-pay" data-pay-id="${p.id}">
            Reject
          </button>`;
      } else if (p.status === 'verified') {
        actionsHtml = `
          <span class="pill green" style="font-size:12px;">Verified by ${esc(p.verified_by || 'Admin')}</span>`;
      } else if (p.status === 'rejected') {
        actionsHtml = `
          <span class="pill" style="color:#ef4444;background:rgba(239,68,68,0.12);font-size:12px;">
            Rejected${p.rejection_reason ? ': ' + esc(p.rejection_reason) : ''}
          </span>`;
      }

      if (p.conversation_id) {
        actionsHtml += `
          <button class="btn-ghost btn-sm btn-jump-chat" data-conv-id="${p.conversation_id}" style="font-size:12px;">
            View chat
          </button>`;
      }

      return `
        <div class="payment-card-item ${isDup ? 'duplicate-border' : ''}" data-item-id="${p.id}">
          <div class="payment-card-top">
            <div class="payment-cust-info">
              <span class="method-badge ${esc(method)}">${esc(method.toUpperCase())}</span>
              <div>
                <div style="font-weight:700;font-size:14.5px;color:var(--ink);">
                  ${esc(custName)} ${custPhone ? `<span class="muted small">(${esc(custPhone)})</span>` : ''}
                </div>
                <div class="muted small">
                  Via ${esc(p.channel || 'webchat')} · ${timeStr}${orderTotal}
                </div>
              </div>
            </div>
            <div class="payment-amount-box">
              <div class="payment-amount-val">৳${esc(Number(p.amount || 0).toLocaleString())}</div>
              <span class="pill ${p.status === 'verified' ? 'green' : (p.status === 'pending' ? 'blue' : '')}">${esc(p.status.toUpperCase())}</span>
            </div>
          </div>

          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <div class="trx-code-badge">
              <span>TrxID:</span>
              <span style="user-select:all;">${esc(p.transaction_id)}</span>
              <button type="button" class="btn-ghost btn-sm btn-copy-trx" data-trx="${esc(p.transaction_id)}" title="Copy TrxID" style="padding:1px 5px;font-size:11px;">Copy</button>
            </div>
            ${isDup ? `<div class="duplicate-warning-badge">Duplicate TrxID — Already used in another order</div>` : ''}
          </div>

          ${p.evidence_text ? `<div class="small muted" style="background:var(--hover);padding:6px 10px;border-radius:8px;font-style:italic;">"${esc(p.evidence_text.slice(0, 150))}"</div>` : ''}

          <div class="payment-card-bottom">
            <div class="muted small">Record ID: #${p.id}</div>
            <div class="payment-actions">
              ${actionsHtml}
            </div>
          </div>
        </div>`;
    }).join('');

    // Bind action handlers
    listEl.querySelectorAll('.btn-verify-pay').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-pay-id');
        btn.disabled = true;
        btn.textContent = 'Verifying…';
        try {
          const r = await api(`/api/payments/${id}/verify`, { method: 'POST', body: JSON.stringify({}) });
          toast(r.message || 'Payment verified!', 'ok');
          loadPayments();
          loadPaymentStats();
        } catch (err) {
          toast('Verification failed: ' + err.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Verify & Confirm';
        }
      };
    });

    listEl.querySelectorAll('.btn-reject-pay').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-pay-id');
        const reason = prompt('Reason for rejection (sent to customer chat):', 'TrxID স্টেটমেন্টে পাওয়া যায়নি / টাকা ক্রেডিট হয়নি');
        if (reason === null) return;
        btn.disabled = true;
        btn.textContent = 'Rejecting…';
        try {
          const r = await api(`/api/payments/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
          toast(r.message || 'Payment rejected', 'err');
          loadPayments();
          loadPaymentStats();
        } catch (err) {
          toast('Failed to reject: ' + err.message, 'err');
          btn.disabled = false;
        }
      };
    });

    listEl.querySelectorAll('.btn-copy-trx').forEach(btn => {
      btn.onclick = () => {
        const trx = btn.getAttribute('data-trx');
        navigator.clipboard.writeText(trx).then(() => toast('TrxID copied to clipboard!', 'ok'));
      };
    });

    listEl.querySelectorAll('.btn-jump-chat').forEach(btn => {
      btn.onclick = () => {
        const convId = Number(btn.getAttribute('data-conv-id'));
        closePaymentsModal();
        showView('inbox');
        selectConversation(convId);
      };
    });

  } catch (err) {
    listEl.innerHTML = `<div class="login-err show" style="margin:16px;">Failed to load payments: ${esc(err.message)}</div>`;
  }
}

function openPaymentsModal() {
  const modal = $('payments-modal');
  if (!modal) return;
  state.paymentsModalOpen = true;
  modal.classList.remove('hidden');
  loadPaymentStats();
  loadPayments(currentPaymentsTab);
}

function closePaymentsModal() {
  const modal = $('payments-modal');
  if (modal) modal.classList.add('hidden');
  state.paymentsModalOpen = false;
}

function initPaymentsHub() {
  document.querySelectorAll('.btn-payments-trigger').forEach(b => {
    b.onclick = openPaymentsModal;
  });
  const btnClose = $('btn-close-payments');
  if (btnClose) btnClose.onclick = closePaymentsModal;
  const btnCloseFoot = $('btn-close-payments-foot');
  if (btnCloseFoot) btnCloseFoot.onclick = closePaymentsModal;

  // Tabs
  const tabsWrap = $('payments-tabs');
  if (tabsWrap) {
    tabsWrap.querySelectorAll('button[data-ptab]').forEach(b => {
      b.onclick = () => {
        tabsWrap.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        loadPayments(b.getAttribute('data-ptab'));
      };
    });
  }

  // Manual record toggle
  const btnToggleMan = $('btn-toggle-manual-pay');
  const boxMan = $('manual-pay-box');
  if (btnToggleMan && boxMan) {
    btnToggleMan.onclick = () => boxMan.classList.toggle('hidden');
  }

  // Submit manual payment
  const btnSubMan = $('btn-submit-manual-pay');
  if (btnSubMan) {
    btnSubMan.onclick = async () => {
      const phone = $('man-pay-phone').value.trim();
      const name = $('man-pay-name').value.trim();
      const method = $('man-pay-method').value;
      const amount = Number($('man-pay-amount').value) || 0;
      const trx = $('man-pay-trx').value.trim();

      if (!trx) {
        toast('Please enter a Transaction ID (TrxID)', 'err');
        return;
      }
      if (amount <= 0) {
        toast('Please enter a valid amount (৳)', 'err');
        return;
      }

      btnSubMan.disabled = true;
      try {
        const res = await api('/api/payments/claim', {
          method: 'POST',
          body: JSON.stringify({
            client_id: state.clientId || 1,
            customer_name: name || 'Direct Customer',
            customer_phone: phone,
            method,
            amount,
            transaction_id: trx,
            channel: 'manual_entry'
          })
        });

        toast(res.duplicate_warning ? 'Payment claimed (Duplicate TrxID warning)' : 'Payment recorded successfully', 'ok');
        $('man-pay-trx').value = '';
        $('man-pay-amount').value = '';
        boxMan.classList.add('hidden');
        loadPayments();
        loadPaymentStats();
      } catch (err) {
        toast('Failed to record payment: ' + err.message, 'err');
      } finally {
        btnSubMan.disabled = false;
      }
    };
  }
}

