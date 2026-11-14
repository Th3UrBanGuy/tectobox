// Tectobox frontend — views/orders.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.


async function loadOrdersPage() {
  const box = $('orders-full-list');
  if (!box) return;
  box.innerHTML = '<div class="small muted" style="padding:24px; text-align:center;">Loading orders & logistics...</div>';
  try {
    const res = await api('/api/orders');
    const orders = res.orders || res || [];
    const statsEl = $('orders-stats-summary');
    if (statsEl) {
      const bookedCount = orders.filter(o => o.courier_status === 'booked').length;
      statsEl.textContent = `${orders.length} orders total · ${bookedCount} booked to courier`;
    }
    if (!orders.length) {
      box.innerHTML = '<div class="warm-empty" style="padding:40px; text-align:center;"><div class="we-ic" style="margin-bottom:8px;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div><b>No orders placed yet</b><p class="muted small" style="margin-top:4px;">Orders created by AI or operators in chat will appear here automatically.</p></div>';
      return;
    }
    box.innerHTML = orders.map(o => {
      let items = [];
      try { items = typeof o.items_json === 'string' ? JSON.parse(o.items_json) : (o.items_json || []); } catch {}
      const dc = Number(o.delivery_charge_bdt) || 0;
      const grandTotal = Number(o.total_bdt) || (Number(o.subtotal_bdt || 0) + dc);
      const isBooked = o.courier_status === 'booked';
      return `
        <div class="card order-card-item" style="padding:16px 20px; display:flex; justify-content:space-between; align-items:center; gap:16px;" data-oid="${o.id}">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
              <b style="font-size:16px; color:var(--ink);">Order #${o.id}</b>
              <span class="pill ${isBooked ? 'green' : 'amber'}">${isBooked ? 'Booked (Steadfast)' : 'Unbooked'}</span>
              ${o.courier_consignment_id ? `<span class="small muted">Tracking: <b>${esc(o.courier_consignment_id)}</b></span>` : ''}
              <span class="small muted" style="margin-left:auto;">${fmtDT(o.created_at)}</span>
            </div>
            <div style="font-size:14px; color:var(--body); margin-bottom:4px;">
              <b>${esc(o.customer_name || 'Customer')}</b> · <span class="muted">${esc(o.customer_phone || '—')}</span>
            </div>
            <div class="small muted" style="margin-bottom:6px;">
              ${items.length ? items.map(i => `${esc(i.name || i.sku)} × ${i.quantity || 1}`).join(', ') : 'Items'}
            </div>
            <div style="font-weight:700; color:var(--ink); font-size:14px;">Total COD: ${grandTotal} BDT</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
            ${!isBooked ? `<button class="btn-primary" data-book-order="${o.id}" style="font-size:13px; padding:7px 14px;">Dispatch parcel</button>` : ''}
            <button class="btn-soft" data-thermal-order="${o.id}" style="font-size:13px; padding:6px 12px;">Thermal slip</button>
          </div>
        </div>
      `;
    }).join('');

    box.querySelectorAll('[data-book-order]').forEach(b => {
      b.onclick = () => {
        const o = orders.find(x => String(x.id) === b.dataset.bookOrder);
        if (o) openCourierBookModal(o);
      };
    });
    box.querySelectorAll('[data-thermal-order]').forEach(b => {
      b.onclick = () => {
        printThermalShippingLabel(b.dataset.thermalOrder);
      };
    });
    return orders.length;
  } catch (e) {
    box.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`;
    return null;
  }
}

// ---------------- Courier & Logistics ----------------
async function openCourierConfigModal() {
  const m = $('courier-modal');
  if (!m) return;
  m.classList.remove('hidden');
  try {
    const cfg = await api('/api/courier/config');
    $('courier-provider').value = cfg.provider || 'steadfast';
    $('sf-api-key').value = cfg.steadfast_api_key || '';
    $('sf-secret-key').value = cfg.steadfast_secret_key || '';
    $('sf-charge-inside').value = cfg.default_delivery_charge_inside ?? 60;
    $('sf-charge-outside').value = cfg.default_delivery_charge_outside ?? 120;
    $('sf-auto-sms').checked = cfg.auto_send_tracking_sms !== false;
  } catch (e) {
    toast('Courier config error: ' + e.message, 'err');
  }
}

async function saveCourierConfig() {
  const payload = {
    provider: $('courier-provider').value,
    steadfast_api_key: $('sf-api-key').value.trim(),
    steadfast_secret_key: $('sf-secret-key').value.trim(),
    default_delivery_charge_inside: Number($('sf-charge-inside').value) || 60,
    default_delivery_charge_outside: Number($('sf-charge-outside').value) || 120,
    auto_send_tracking_sms: $('sf-auto-sms').checked,
  };
  try {
    await api('/api/courier/config', { method: 'POST', body: JSON.stringify(payload) });
    toast('Courier configuration saved successfully ✓');
    $('courier-modal').classList.add('hidden');
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
}

function openCourierBookModal(order) {
  const m = $('courier-book-modal');
  if (!m) return;
  $('cb-order-id').value = order.id;
  $('cb-sub').textContent = `Booking Order #${order.id} for dispatch via Steadfast Courier`;
  $('cb-name').value = order.customer_name || '';
  $('cb-phone').value = order.customer_phone || '';
  $('cb-address').value = order.customer_address || '';
  const dc = Number(order.delivery_charge_bdt) || 0;
  const tot = Number(order.total_bdt) || (Number(order.subtotal_bdt || 0) + dc);
  const advPaid = Number(order.advance_paid_bdt) || 0;
  const codDue = Math.max(0, tot - advPaid);
  $('cb-cod').value = codDue;
  $('cb-note').value = `Order #${order.id}`;
  m.classList.remove('hidden');
}

async function confirmCourierBooking() {
  const orderId = Number($('cb-order-id').value);
  const btn = $('btn-confirm-cbook');
  btn.disabled = true;
  btn.textContent = 'Booking with Steadfast...';
  try {
    const res = await api('/api/courier/steadfast/book', {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        recipient_name: $('cb-name').value.trim(),
        recipient_phone: $('cb-phone').value.trim(),
        recipient_address: $('cb-address').value.trim(),
        cod_amount: Number($('cb-cod').value) || 0,
        note: $('cb-note').value.trim(),
      })
    });
    toast(`Booked with Steadfast. Tracking: ${res.tracking_code}`);
    $('courier-book-modal').classList.add('hidden');
    const conv = state.conversations.find(c => c.id === state.activeId);
    if (conv) renderCustomerTab(conv);
    if ($('orders-modal') && !$('orders-modal').classList.contains('hidden')) openOrdersModal();
  } catch (e) {
    toast('Booking failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm & dispatch';
  }
}

// ---------------- 4x6" Thermal Shipping Slip ----------------
async function printThermalShippingLabel(orderId) {
  let orderData;
  try {
    orderData = await api(`/api/orders/${orderId}/invoice`);
  } catch (e) {
    toast('Failed to load invoice: ' + e.message, 'err');
    return;
  }
  const o = orderData.order;
  // The invoice endpoint can return {} on a backend hiccup — never crash
  // the whole view on a missing order (2026-11-13 click audit).
  if (!o) { toast('Failed to load invoice', 'err'); return; }
  const clientName = orderData.clientName || 'TECTOBOX STORE';
  let items = orderData.items || [];
  const dc = Number(o.delivery_charge_bdt) || 0;
  const total = Number(o.total_bdt) || (Number(o.subtotal_bdt || 0) + dc);
  const advPaid = Number(o.advance_paid_bdt) || 0;
  const codDue = Math.max(0, total - advPaid);
  const trackingCode = o.courier_tracking_code || `STEAD-${o.id}-${Date.now().toString().slice(-4)}`;

  const labelHtml = `
    <div class="thermal-sheet">
      <div class="ts-head">
        <div>
          <div class="ts-store">${esc(clientName)}</div>
          <div style="font-size:11px; color:#555;">Order ID: #${o.id} · ${fmtDT(o.created_at)}</div>
        </div>
        <div class="ts-courier">
          <div class="ts-cname">STEADFAST COURIER</div>
          <div style="font-size:10px; color:#555;">Standard COD Delivery</div>
        </div>
      </div>

      <div class="ts-barcode">
        <div class="ts-code">${esc(trackingCode)}</div>
        <div style="font-size:10px; letter-spacing:1px; margin-top:2px;">|||||| |||||||||| |||||| |||||||| ||||||</div>
      </div>

      <div class="ts-recipient">
        <div class="ts-lbl">Recipient Delivery Details</div>
        <div class="ts-name">${esc(o.customer_name || 'Valued Customer')}</div>
        <div class="ts-phone">Phone: ${esc(o.customer_phone || '—')}</div>
        <div class="ts-addr">Address: ${esc(o.customer_address || 'Dhaka, Bangladesh')}</div>
      </div>

      <div class="ts-cod-box">
        <div class="ts-cod-title">Cash to Collect (COD)</div>
        <div class="ts-cod-amt">৳${codDue.toLocaleString('en-US')}</div>
      </div>

      <div class="ts-items">
        <div style="font-weight:700; margin-bottom:4px;">Item Details:</div>
        ${items.map(i => `<div>• ${i.qty || 1}x ${esc(i.name || i.sku || 'Item')} — ৳${Number(i.price_bdt || 0).toLocaleString('en-US')}</div>`).join('')}
        ${dc ? `<div style="color:#555;">• Delivery Fee: ৳${dc}</div>` : ''}
      </div>

      <div class="ts-foot">
        <div>Generated by Tectobox</div>
        <div>Please handle with care</div>
      </div>
    </div>
  `;

  $('thermal-preview-container').innerHTML = labelHtml;
  $('thermal-print-area').innerHTML = labelHtml;
  $('thermal-label-modal').classList.remove('hidden');

  $('btn-print-thermal').onclick = () => {
    window.print();
  };
}

// ---------------- Orders & Shipping Slips Modal ----------------
async function openOrdersModal() {
  const m = $('orders-modal');
  if (!m) return;
  m.classList.remove('hidden');
  const box = $('orders-modal-list');
  box.innerHTML = '<div class="small muted" style="padding:20px; text-align:center;">Loading orders...</div>';
  try {
    const res = await api('/api/orders');
    const orders = res.orders || res || [];
    if (!orders.length) {
      box.innerHTML = '<div class="warm-empty" style="padding:30px;"><div class="we-ic"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div><b>No orders yet</b><p>Orders created from inbox chats will appear here.</p></div>';
      return;
    }
    box.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${orders.map(o => {
          let items = [];
          try { items = typeof o.items_json === 'string' ? JSON.parse(o.items_json) : (o.items_json || []); } catch {}
          const dc = Number(o.delivery_charge_bdt) || 0;
          const grandTotal = Number(o.total_bdt) || (Number(o.subtotal_bdt || 0) + dc);
          const isBooked = o.courier_status === 'booked';
          return `
            <div class="card" style="display:flex; justify-content:space-between; align-items:center; gap:14px; padding:14px 18px;">
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                  <b style="font-size:15px; color:var(--ink);">Order #${o.id}</b>
                  <span class="pill ${isBooked ? 'green' : 'amber'}">${isBooked ? 'Booked' : 'Unbooked'}</span>
                  <span class="small muted">${fmtDT(o.created_at)}</span>
                </div>
                <div style="font-size:13px; color:var(--body);"><b>${esc(o.customer_name || 'Customer')}</b> (${esc(o.customer_phone || '—')})</div>
                <div class="muted small" style="margin-top:2px;">${items.map(i => `${i.qty}x ${esc(i.name || i.sku)}`).join(', ')}</div>
                ${o.courier_tracking_code ? `<div style="font-size:12px; font-weight:700; color:var(--accent); margin-top:4px;">Tracking: ${esc(o.courier_tracking_code)}</div>` : ''}
              </div>
              <div style="text-align:right; flex-shrink:0;">
                <div style="font-weight:700; font-size:16px; color:var(--ink);">৳${grandTotal.toLocaleString('en-US')}</div>
                <div style="display:flex; gap:6px; margin-top:8px;">
                  ${!isBooked ? `<button class="btn-primary" style="padding:6px 12px; font-size:12px;" data-book-order="${o.id}">Book courier</button>` : ''}
                  <button class="btn-soft" style="padding:6px 12px; font-size:12px;" data-print-order="${o.id}">Print label</button>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    box.querySelectorAll('[data-book-order]').forEach(btn => {
      btn.onclick = () => {
        const o = orders.find(x => String(x.id) === btn.dataset.bookOrder);
        if (o) openCourierBookModal(o);
      };
    });
    box.querySelectorAll('[data-print-order]').forEach(btn => {
      btn.onclick = () => printThermalShippingLabel(btn.dataset.printOrder);
    });
  } catch (e) {
    box.innerHTML = `<div class="card err" style="padding:20px;">Failed to load orders: ${esc(e.message)}</div>`;
  }
}
