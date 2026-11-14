// Tectobox frontend — lib/state.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

const state = {
  me: null,            // {username, role, clientId}
  clientId: null,      // from /api/auth/me (client role)
  view: null,          // client sub-view or 'admin'
  conversations: [],
  messages: [],
  activeId: null,
  platformFilter: 'all',
  convQuery: '',
  needsHuman: false,
  products: [],
  orderLines: {},
  status: {},
  leads: [],
  leadTemp: 'all',
  leadStage: 'all',
  leadSegment: 'all',
  leadQuery: '',
  knowledge: [],
  connectors: {},
  editingLeadId: null,
  editingProductId: null,
  qrChannel: null,
  qrSlot: null,
  adminTab: 'resources',
  settingsTab: 'channels',
  kbSubTab: 'docs',
  access: null,          // workspace license + feature grants from /api/client/access
};

const VIEW_REQ = {
  inbox: 'combined_inbox',
  kb: 'knowledge',
  webchat: 'webchat',
  apikeys: 'api_access',
  broadcast: 'broadcast',
};
const VIEW_ORDER = [
  'inbox', 'leads', 'orders', 'products', 'channels', 'kb',
  'webchat', 'backup', 'plan', 'apikeys', 'broadcast', 'guide', 'more',
];
// First view the client is allowed to see, in nav order. 'more' (Account)
// has no req and is always the fallback.
