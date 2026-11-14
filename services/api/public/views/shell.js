// Tectobox frontend — views/shell.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

function renderNav() {
  const isAdminUser = state.me && isAdmin(state.me.role);

  const mainItems = [
    { id: 'inbox', label: 'Inbox', icon: 'inbox', req: 'combined_inbox' },
    { id: 'leads', label: 'Leads', icon: 'leads' },
    { id: 'orders', label: 'Orders', icon: 'cart' },
  ];
  if (isAdminUser) {
    mainItems.push({ id: 'admin', label: 'Platform Panel', icon: 'grid' });
  }

  const workspaceItems = [
    { id: 'payments', label: 'Payments Hub', icon: 'card' },
    { id: 'products', label: 'My Products', icon: 'box' },
    { id: 'channels', label: 'Connect Channels', icon: 'channels' },
    { id: 'kb', label: 'Teach the AI', icon: 'brain', req: 'knowledge' },
    { id: 'webchat', label: 'Chat Widget Style', icon: 'palette', req: 'webchat' },
    { id: 'backup', label: 'Backup My Data', icon: 'cloud' },
    { id: 'plan', label: 'My Plan', icon: 'crown' },
    { id: 'apikeys', label: 'API Keys', icon: 'key', req: 'api_access' },
    { id: 'broadcast', label: 'Broadcast', icon: 'broadcast', req: 'broadcast' },
    { id: 'guide', label: 'Help & Guides', icon: 'compass' },
  ];

  const buildGroup = (headerTitle, items) => `
    <div class="sidebar-group">
      <div class="sidebar-group-header">
        <span class="cat-dot"></span>
        <span>${headerTitle}</span>
      </div>
      ${items.map(i => {
        const isHidden = (i.req && !hasFeature(i.req));
        const badge = (i.id === 'payments' && state.pendingPaymentsCount > 0)
          ? `<span class="badge-pending-count" style="margin-left:auto;position:static;display:inline-flex;">${state.pendingPaymentsCount}</span>`
          : '';
        return `
        <button class="nav-link" data-nav="${i.id}" title="${esc(i.label)}" style="${isHidden ? 'display:none;' : ''}">
          <span class="nav-active-bar"></span>
          <span class="nav-icon-badge">
            ${ICONS[i.icon] || ''}
          </span>
          <span class="nav-text">${esc(i.label)}</span>
          ${badge}
        </button>
      `;
      }).join('')}
    </div>
  `;

  // Hidden compatibility button for tests / scripts expecting data-nav="more"
  const legacyMore = '<button class="nav-link hidden-more-btn" data-nav="more" style="display:none;"></button>';

  $('nav-links').innerHTML = buildGroup('MAIN', mainItems) + buildGroup('WORKSPACE', workspaceItems) + legacyMore;

  document.querySelectorAll('#nav-links .nav-link').forEach(b => {
    b.onclick = () => {
      showView(b.dataset.nav);
      if (b.dataset.nav === 'admin') loadAdmin();
    };
  });

  // Mobile bottom tab bar — first tab opens the sidebar drawer (Menu)
  const mobileItems = isAdminUser
    ? [
        { id: 'menu', label: 'Menu', icon: 'menu' },
        { id: 'admin', label: 'Admin', icon: 'grid' },
        { id: 'inbox', label: 'Inbox', icon: 'inbox', req: 'combined_inbox' },
        { id: 'leads', label: 'Leads', icon: 'sheets' },
        { id: 'more', label: 'Account', icon: 'crown' },
      ]
    : [
        { id: 'menu', label: 'Menu', icon: 'menu' },
        { id: 'inbox', label: 'Inbox', icon: 'inbox', req: 'combined_inbox' },
        { id: 'leads', label: 'Leads', icon: 'sheets' },
        { id: 'orders', label: 'Orders', icon: 'cart' },
        { id: 'products', label: 'Products', icon: 'box' },
        { id: 'more', label: 'Account', icon: 'crown' },
      ];
  const visibleMobile = mobileItems.filter(i => !i.req || hasFeature(i.req));
  const bt = $('bottom-tabs');
  if (bt) {
    bt.innerHTML = visibleMobile.map(i =>
      `<button class="btab" data-nav="${i.id}">${ICONS[i.icon] || ''}<span>${esc(i.label)}</span></button>`).join('');
    document.querySelectorAll('#bottom-tabs .btab').forEach(b =>
      b.onclick = () => {
        if (b.dataset.nav === 'menu') { toggleMobileDrawer(); return; }
        showView(b.dataset.nav); if (b.dataset.nav === 'admin') loadAdmin();
      });
  }
}

var VIEW_TITLES = {
  admin: 'Platform Panel',
  inbox: 'Inbox',
  leads: 'Leads',
  orders: 'Orders & Logistics',
  products: 'My Products',
  channels: 'Connect Channels',
  kb: 'Teach the AI',
  webchat: 'Chat Widget Style',
  backup: 'Backup My Data',
  plan: 'My Plan',
  apikeys: 'API Keys',
  broadcast: 'Broadcast',
  guide: 'Help & Guides',
  more: 'More',
  settings: 'Settings'
};

const ALL_VIEWS = [
  'inbox', 'leads', 'orders', 'products', 'channels', 'kb',
  'webchat', 'backup', 'plan', 'apikeys', 'broadcast', 'guide', 'more', 'settings'
];

function firstAvailableView() {
  for (const v of VIEW_ORDER) {
    const req = VIEW_REQ[v];
    if (!req || hasFeature(req)) return v;
  }
  return 'more';
}
// Re-apply the active highlight after renderNav() rebuilds the nav buttons.
function markActiveNav() {
  document.querySelectorAll('#nav-links .nav-link').forEach(b => b.classList.toggle('active', b.dataset.nav === state.view));
  document.querySelectorAll('#bottom-tabs .btab').forEach(b => b.classList.toggle('active', b.dataset.nav === state.view));
}

function showView(view) {
  // Licence defence in depth: a view whose feature the client lacks is never
  // rendered — redirect to the first available view instead.
  const req = VIEW_REQ[view];
  if (req && !hasFeature(req)) {
    const fallback = firstAvailableView();
    if (fallback !== view) { showView(fallback); return; }
  }
  // 'settings' is a dead hub (cview-settings is display:none and its tabs
  // control stabs that live in other pages) — never show it blank; land on
  // the requested settings tab's real page instead (2026-11-13: the inbox
  // "Connect a channel" button landed on a blank screen here).
  if (view === 'settings') { showView(SETTINGS_TAB_VIEW[state.settingsTab] || 'channels'); return; }
  // Any navigation closes the mobile sidebar drawer
  document.body.classList.remove('sidebar-open');
  state.view = view;
  var _tt = $('topnav-title'); if (_tt) _tt.textContent = VIEW_TITLES[view] || '';

  // Active state on sidebar and bottom tabs
  document.querySelectorAll('#nav-links .nav-link').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  document.querySelectorAll('#bottom-tabs .btab').forEach(b => b.classList.toggle('active', b.dataset.nav === view));

  $('inbox-panes').classList.remove('m-chat-open', 'm-detail-open');
  const adminMode = state.me && isAdmin(state.me.role);
  const onAdminDash = adminMode && view === 'admin';
  $('view-client').classList.toggle('hidden', onAdminDash);
  $('view-admin').classList.toggle('hidden', !onAdminDash);

  for (const v of ALL_VIEWS) {
    var _cv = $('cview-' + v);
    if (_cv) {
      const isTarget = (view === v);
      _cv.classList.toggle('hidden', !isTarget);
      if (isTarget) {
        _cv.classList.remove('view-enter'); void _cv.offsetWidth; _cv.classList.add('view-enter');
      }
    }
  }

  if (view === 'payments') { openPaymentsModal(); return; }
  if (view === 'inbox') {
    loadConversations();
    if (!state.activeId) renderChatHeader(null);
  }
  if (view === 'leads') loadLeads();
  if (view === 'orders') loadOrdersPage();
  if (view === 'products') loadProducts();
  if (view === 'channels') { $('stab-channels')?.classList.remove('hidden'); loadConnectors(); }
  if (view === 'kb') { $('stab-kb')?.classList.remove('hidden'); switchKbSubTab(state.kbSubTab); loadKnowledge(); }
  if (view === 'webchat') { $('stab-appearance')?.classList.remove('hidden'); loadAppearanceTab(); }
  if (view === 'backup') { $('stab-backup')?.classList.remove('hidden'); loadBackupTab(); }
  if (view === 'plan') { $('stab-plan')?.classList.remove('hidden'); renderPlanTab(); }
  if (view === 'apikeys') { $('stab-apikeys')?.classList.remove('hidden'); renderApiKeysTab(); }
  if (view === 'broadcast') renderBroadcast();
  if (view === 'guide') renderGuide();
  if (view === 'more') renderMore();
  if (view === 'settings') { switchSettingsTab(state.settingsTab); renderSetupChecklist(); }
  if (view === 'admin') loadAdmin();
}
// ---------------- command palette (Cmd+K) ----------------
const CMDK_ACTIONS = [
  { id:'go-inbox', t:'Go to Inbox', s:'View conversations', ic:'M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z', run:() => showView('inbox') },
  { id:'go-leads', t:'Go to Leads', s:'Lead intelligence', ic:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', run:() => showView('leads') },
  { id:'go-more', t:'Go to More', s:'Workspace hub', ic:'M12 5v14M5 12h14', run:() => showView('more') },
  { id:'go-broadcast', t:'Broadcast', s:'Campaign messages', ic:'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z', run:() => showView('broadcast'), req:'broadcast' },
  { id:'go-products', t:'Products', s:'Manage catalog', ic:'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2', run:() => showView('products') },
  { id:'go-settings', t:'Settings', s:'Channels, widget, preferences', ic:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z', run:() => showView('settings') },
  { id:'add-product', t:'Add product', s:'New catalog item', ic:'M12 5v14M5 12h14', run:() => { showView('products'); setTimeout(() => openProductModal(null), 150); } },
  { id:'theme', t:'Toggle theme', s:'Light / dark mode', ic:'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', run:() => $('btn-theme')?.click() },
  { id:'shortcuts', t:'Keyboard shortcuts', s:'View all shortcuts', ic:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', run:() => $('shortcuts-modal').classList.remove('hidden') },
  { id:'logout', t:'Log out', s:'End session', ic:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', run:() => $('btn-signout')?.click() },
];
let cmdkSel = 0, cmdkItems = [];
function openCmdk() {
  $('cmdk-bg').classList.remove('hidden');
  $('cmdk-input').value = '';
  renderCmdk('');
  setTimeout(() => $('cmdk-input').focus(), 30);
}
function closeCmdk() { $('cmdk-bg').classList.add('hidden'); }
function renderCmdk(q) {
  const ql = q.toLowerCase();
  cmdkItems = CMDK_ACTIONS.filter(a =>
    (!a.req || hasFeature(a.req)) &&
    (!ql || a.t.toLowerCase().includes(ql) || a.s.toLowerCase().includes(ql)));
  // admin action only for admins
  if (state.me && isAdmin(state.me.role) && (!ql || 'platform panel'.includes(ql))) {
    cmdkItems.push({ id:'go-admin', t:'Platform Panel', s:'Admin dashboard', ic:'M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z', run:() => showView('admin') });
  }
  cmdkSel = 0;
  $('cmdk-list').innerHTML = cmdkItems.length ? cmdkItems.map((a, i) => `
    <div class="cmdk-item ${i === 0 ? 'sel' : ''}" data-ci="${i}" role="option">
      <span class="ci-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${a.ic}"/></svg></span>
      <span class="ci-tx"><b>${esc(a.t)}</b><span>${esc(a.s)}</span></span>
    </div>`).join('')
    : '<div class="cmdk-empty">No matching commands.</div>';
  document.querySelectorAll('.cmdk-item').forEach(el => {
    el.onclick = () => { const a = cmdkItems[+el.dataset.ci]; closeCmdk(); a && a.run(); };
    el.onmousemove = () => { cmdkSel = +el.dataset.ci; paintCmdkSel(); };
  });
}
function paintCmdkSel() {
  document.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('sel', i === cmdkSel));
  document.querySelectorAll('.cmdk-item')[cmdkSel]?.scrollIntoView({ block:'nearest' });
}
function initCmdk() {
  $('cmdk-input').addEventListener('input', e => renderCmdk(e.target.value));
  $('cmdk-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = Math.min(cmdkSel + 1, cmdkItems.length - 1); paintCmdkSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = Math.max(cmdkSel - 1, 0); paintCmdkSel(); }
    else if (e.key === 'Enter') { const a = cmdkItems[cmdkSel]; closeCmdk(); a && a.run(); }
    else if (e.key === 'Escape') closeCmdk();
  });
  $('cmdk-bg').addEventListener('click', e => { if (e.target === $('cmdk-bg')) closeCmdk(); });
  // Unified keyboard handling: Cmd+K, g-sequences, ?, Escape
  let gPending = false, gTimer = null;
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+K: command palette
    if (mod && (e.key?.toLowerCase() === 'k' || e.code === 'KeyK')) {
      e.preventDefault();
      if ($('app-view').classList.contains('hidden')) return;
      $('cmdk-bg').classList.contains('hidden') ? openCmdk() : closeCmdk();
      return;
    }
    // Escape: close topmost modal (palette handles its own)
    if (e.key === 'Escape') {
      if (!$('cmdk-bg').classList.contains('hidden')) return; // palette input handles it
      const open = [...document.querySelectorAll('.modal-bg')].find(m => !m.classList.contains('hidden') && m.id !== 'cmdk-bg');
      if (open) { open.classList.add('hidden'); e.stopPropagation(); }
      return;
    }
    if (mod || e.altKey) return;
    if (e.target.matches('input, textarea, select')) return;
    if ($('app-view').classList.contains('hidden')) return;
    // ? opens shortcuts help
    if (e.key === '?' && !gPending) { $('shortcuts-modal').classList.remove('hidden'); return; }
    if (gPending) {
      clearTimeout(gTimer); gPending = false;
      const k = e.key.toLowerCase();
      if (k === 'i') showView('inbox');
      else if (k === 'l') showView('leads');
      else if (k === 'm') showView('more');
      else if (k === 'p') showView('products');
      else if (k === 's') showView('settings');
      return;
    }
    if (e.key.toLowerCase() === 'g') {
      gPending = true;
      gTimer = setTimeout(() => gPending = false, 1500);
    }
  });
}

// ---------------- more / settings (native) ----------------
// Each settings tab lives in its own page now (channels, kb, webchat,
// backup, plan, apikeys) — the old cview-settings hub is display:none, so
// route each tab to its real page instead of the dead hub.
const SETTINGS_TAB_VIEW = { channels: 'channels', kb: 'kb', appearance: 'webchat', backup: 'backup', plan: 'plan', apikeys: 'apikeys' };
function gotoSettings(tab) { showView(SETTINGS_TAB_VIEW[tab || 'channels'] || 'channels'); }
/* Mobile drawer (≤900px): the bottom-dock "Menu" tab opens the full sidebar
   as an overlay drawer. Closes via scrim, close button, any navigation
   (showView), Escape, or resize to desktop. */
function toggleMobileDrawer() {
  const sidebar = $('app-sidebar');
  const opening = !document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open', opening);
  if (opening && sidebar) sidebar.classList.remove('collapsed');
}
function initMobileDrawer() {
  const scrim = $('sidebar-scrim');
  if (scrim) scrim.onclick = () => document.body.classList.remove('sidebar-open');
  const closeBtn = $('btn-sidebar-close');
  if (closeBtn) closeBtn.onclick = () => document.body.classList.remove('sidebar-open');
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.body.classList.remove('sidebar-open');
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) document.body.classList.remove('sidebar-open');
  });
}

function initSidebarCollapse() {
  const sidebar = $('app-sidebar');
  const toggleBtn = $('btn-sidebar-collapse');
  const resizer = $('sidebar-resizer');
  if (!sidebar) return;

  function setCollapsed(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    if (toggleBtn) {
      toggleBtn.title = collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)';
      const arrow = toggleBtn.querySelector('.sidebar-toggle-arrow');
      if (arrow) arrow.setAttribute('d', collapsed ? 'M10 9l3 3-3 3' : 'M14 9l-3 3 3 3');
    }
    try {
      localStorage.setItem('tectobox_sidebar_collapsed', collapsed ? '1' : '0');
    } catch (e) {}
  }

  // Restore saved state
  try {
    const isSavedCollapsed = localStorage.getItem('tectobox_sidebar_collapsed') === '1';
    if (isSavedCollapsed) {
      setCollapsed(true);
    }
  } catch (e) {}

  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      setCollapsed(!sidebar.classList.contains('collapsed'));
    };
  }

  // Clicking brand in collapsed mode expands it
  const brand = $('sidebar-brand-click');
  if (brand) {
    brand.onclick = () => {
      if (sidebar.classList.contains('collapsed')) {
        setCollapsed(false);
      }
    };
  }

  // Keyboard shortcut Ctrl+B / Cmd+B
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
        e.preventDefault();
        setCollapsed(!sidebar.classList.contains('collapsed'));
      }
    }
  });

  // Resizer dragging logic for "ছোট করা যাবে, বড় করা যাবে"
  if (resizer) {
    let isDragging = false;
    let startX = 0;
    let startWidth = 250;

    resizer.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      sidebar.classList.add('is-resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const delta = e.clientX - startX;
      let newWidth = startWidth + delta;
      if (newWidth < 120) {
        setCollapsed(true);
      } else {
        if (sidebar.classList.contains('collapsed')) {
          setCollapsed(false);
        }
        if (newWidth > 420) newWidth = 420;
        if (newWidth < 180) newWidth = 180;
        sidebar.style.setProperty('--sidebar-width', `${newWidth}px`);
      }
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      sidebar.classList.remove('is-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!sidebar.classList.contains('collapsed')) {
        try {
          const curW = sidebar.getBoundingClientRect().width;
          localStorage.setItem('tectobox_sidebar_width', `${Math.round(curW)}px`);
        } catch (e) {}
      }
    });

    // Double-click resizer to toggle collapse
    resizer.addEventListener('dblclick', () => {
      setCollapsed(!sidebar.classList.contains('collapsed'));
    });
  }

  // Restore saved width if not collapsed
  try {
    const savedWidth = localStorage.getItem('tectobox_sidebar_width');
    const isSavedCollapsed = localStorage.getItem('tectobox_sidebar_collapsed') === '1';
    if (savedWidth && !isSavedCollapsed) {
      sidebar.style.setProperty('--sidebar-width', savedWidth);
    }
  } catch (e) {}
}
