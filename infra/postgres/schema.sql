-- Tectobox PostgreSQL Schema

-- Enables UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Clients (Tenants)
CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    business_type VARCHAR(50) NOT NULL DEFAULT 'physical' CHECK(business_type IN ('physical','digital')),
    lead_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    widget_key VARCHAR(255) UNIQUE,
    website_url TEXT,
    wc_title TEXT,
    wc_greeting TEXT,
    wc_color VARCHAR(50),
    wc_position VARCHAR(50),
    wc_avatar TEXT,
    wc_subtitle TEXT,
    wc_require_intro BOOLEAN DEFAULT true,
    widget_ai_daily_cap INTEGER NOT NULL DEFAULT 200,
    widget_ai_used INTEGER NOT NULL DEFAULT 0,
    widget_ai_day VARCHAR(50) NOT NULL DEFAULT '',
    ai_paused BOOLEAN NOT NULL DEFAULT false,
    suspended BOOLEAN NOT NULL DEFAULT false,
    delete_scheduled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    platform_user_id VARCHAR(255) NOT NULL,
    slot VARCHAR(50) NOT NULL DEFAULT 'default',
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    customer_contact TEXT,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    unread_count INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'open',
    needs_human BOOLEAN NOT NULL DEFAULT false,
    needs_human_reason TEXT,
    UNIQUE(client_id, platform, platform_user_id, slot)
);

-- Messages
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL CHECK(direction IN ('in','out')),
    text TEXT NOT NULL,
    raw_json JSONB,
    external_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(conversation_id, external_id)
);

-- Products
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    sku VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(255),
    price_bdt DECIMAL(12,2) NOT NULL,
    stock INTEGER DEFAULT 0,
    image_url TEXT,
    UNIQUE(client_id, sku)
);

-- Orders
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    items_json JSONB NOT NULL,
    subtotal_bdt DECIMAL(12,2) NOT NULL DEFAULT 0,
    delivery_charge_bdt DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_bdt DECIMAL(12,2) NOT NULL,
    advance_required_bdt DECIMAL(12,2) NOT NULL DEFAULT 0,
    advance_paid_bdt DECIMAL(12,2) NOT NULL DEFAULT 0,
    transaction_id VARCHAR(255),
    payment_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    status VARCHAR(50) DEFAULT 'confirmed',
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    idempotency_key VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, idempotency_key)
);

-- Leads
CREATE TABLE leads (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    platform_user_id VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    phone VARCHAR(50),
    email VARCHAR(255),
    whatsapp_id VARCHAR(255),
    location TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'lead' CHECK(status IN ('lead','user','confirmed')),
    stage VARCHAR(50) NOT NULL DEFAULT 'new',
    score INTEGER NOT NULL DEFAULT 0,
    temperature VARCHAR(50) NOT NULL DEFAULT 'cold',
    product_affinity_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    intent_summary TEXT NOT NULL DEFAULT '',
    predicted_value_bdt DECIMAL(12,2) NOT NULL DEFAULT 0,
    conversion_probability DECIMAL(5,4) NOT NULL DEFAULT 0,
    next_action TEXT NOT NULL DEFAULT '',
    source VARCHAR(255) NOT NULL DEFAULT '',
    verification_state VARCHAR(50) NOT NULL DEFAULT 'unverified',
    notes TEXT,
    last_intent_at TIMESTAMPTZ,
    followup_due_at TIMESTAMPTZ,
    intel_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, platform, platform_user_id)
);

-- Knowledge
CREATE TABLE knowledge (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL DEFAULT 'general',
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    source_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Channel Sessions
CREATE TABLE channel_sessions (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    channel VARCHAR(50) NOT NULL,
    slot VARCHAR(50) NOT NULL DEFAULT 'default',
    session_json JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'disconnected',
    label VARCHAR(255),
    ai_paused BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, channel, slot)
);

-- Meta Pages
CREATE TABLE meta_pages (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    channel VARCHAR(50) NOT NULL,
    page_id VARCHAR(255) NOT NULL,
    page_name VARCHAR(255),
    page_access_token TEXT NOT NULL,
    ig_user_id VARCHAR(255),
    ig_username VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'connected',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, channel)
);

-- Users
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'client',
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Settings
CREATE TABLE settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit Log
CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    actor VARCHAR(255),
    event VARCHAR(255) NOT NULL,
    target VARCHAR(255),
    ip VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Broadcasts
CREATE TABLE broadcasts (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    channel VARCHAR(50) NOT NULL DEFAULT 'all',
    text TEXT NOT NULL DEFAULT '',
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Broadcast Recipients
CREATE TABLE broadcast_recipients (
    id SERIAL PRIMARY KEY,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    platform_user_id VARCHAR(255) NOT NULL,
    customer_name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    error TEXT,
    sent_at TIMESTAMPTZ,
    UNIQUE (broadcast_id, platform, platform_user_id)
);

-- API Keys
CREATE TABLE api_keys (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) UNIQUE NOT NULL,
    key_prefix VARCHAR(50) NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client Webhooks
CREATE TABLE client_webhooks (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events VARCHAR(255) NOT NULL DEFAULT 'message.received,lead.created,order.created',
    secret VARCHAR(255) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- FB Comment Log
CREATE TABLE fb_comment_log (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    page_id VARCHAR(255) NOT NULL,
    comment_id VARCHAR(255) UNIQUE NOT NULL,
    post_id VARCHAR(255),
    commenter_id VARCHAR(255),
    commenter_name VARCHAR(255),
    comment_text TEXT,
    reply_text TEXT,
    dm_sent BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Website Imports
CREATE TABLE website_imports (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    website_url TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    discovered INTEGER DEFAULT 0,
    imported INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    error TEXT
);

-- Website Import Pages
CREATE TABLE website_import_pages (
    id SERIAL PRIMARY KEY,
    import_id INTEGER NOT NULL REFERENCES website_imports(id) ON DELETE CASCADE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    page_title VARCHAR(255),
    category VARCHAR(100) DEFAULT 'general',
    chars INTEGER DEFAULT 0,
    status VARCHAR(50) NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Push Subscriptions
CREATE TABLE push_subscriptions (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client Drive Tokens
CREATE TABLE client_drive_tokens (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at BIGINT DEFAULT 0,
    email VARCHAR(255),
    connected_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin TOTP
CREATE TABLE admin_totp (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
    id VARCHAR(255) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plans
CREATE TABLE plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    kind VARCHAR(50) NOT NULL DEFAULT 'time' CHECK(kind IN ('time','credit','feature')),
    billing_period VARCHAR(50) CHECK(billing_period IN ('monthly','quarterly','yearly')),
    features_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    credits_included INTEGER NOT NULL DEFAULT 0,
    price_bdt INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Licenses
CREATE TABLE licenses (
    id SERIAL PRIMARY KEY,
    code VARCHAR(255) UNIQUE NOT NULL,
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kind VARCHAR(50) NOT NULL DEFAULT 'time' CHECK(kind IN ('time','credit','feature')),
    billing_period VARCHAR(50) CHECK(billing_period IN ('monthly','quarterly','yearly')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    credits_total INTEGER NOT NULL DEFAULT 0,
    credits_used INTEGER NOT NULL DEFAULT 0,
    features_json JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','expired','cancelled')),
    note TEXT,
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- License Feature Credits
CREATE TABLE license_feature_credits (
    license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    feature VARCHAR(255) NOT NULL,
    mode VARCHAR(50) NOT NULL DEFAULT 'unlimited' CHECK(mode IN ('unlimited','credit')),
    credits_total INTEGER NOT NULL DEFAULT 0,
    credits_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (license_id, feature)
);

-- Transactional Inbox / Outbox
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aggregate_type VARCHAR(255) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE TABLE inbox_events (
    id UUID PRIMARY KEY,
    source VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Indexes for performance
CREATE INDEX idx_conversations_client ON conversations(client_id);
CREATE INDEX idx_conversations_client_last_msg ON conversations(client_id, last_message_at DESC);
CREATE INDEX idx_conversations_platform ON conversations(client_id, platform);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_conv_created ON messages(conversation_id, created_at ASC);
CREATE INDEX idx_products_client ON products(client_id);
CREATE INDEX idx_orders_client ON orders(client_id);
CREATE INDEX idx_orders_client_status ON orders(client_id, status, created_at DESC);
CREATE INDEX idx_leads_client ON leads(client_id);
CREATE INDEX idx_leads_client_stage ON leads(client_id, stage);
CREATE INDEX idx_knowledge_client ON knowledge(client_id);
CREATE INDEX idx_meta_pages_client ON meta_pages(client_id);
CREATE INDEX idx_licenses_client_status ON licenses(client_id, status);
CREATE INDEX idx_sessions_user_expires ON sessions(user_id, expires_at);
CREATE INDEX idx_outbox_unprocessed ON outbox_events(created_at) WHERE processed_at IS NULL;
