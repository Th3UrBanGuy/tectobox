-- Extensions needed by the new services
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Default seed workspace (clients only).
-- NOTE (C1): no user rows are seeded here anymore. The admin/operator seed
-- password hashes were removed because they were committed to the public
-- repo. The first platform admin must be provisioned out-of-band (e.g. a
-- one-off psql INSERT with a strong, randomly generated password hash, or
-- the seed script with SEED_ADMIN_PASSWORD set in the operator's shell) —
-- never by committing a credential to this file.
INSERT INTO clients (id, name, business_type, widget_key, created_at)
VALUES (1, 'Main Workspace', 'physical', 'wk_main_workspace_seed', NOW())
ON CONFLICT (id) DO NOTHING;

SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM users));
SELECT setval('clients_id_seq', (SELECT COALESCE(MAX(id), 1) FROM clients));
