-- Extensions needed by the new services
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Default seed workspace and users
INSERT INTO clients (id, name, business_type, widget_key, created_at)
VALUES (1, 'Main Workspace', 'physical', 'wk_main_workspace_seed', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, role, client_id, password_hash, active, created_at)
VALUES 
  (1, 'admin', 'admin', NULL, '0bba8e19c8d3de083aeb8f747aaf667b:97c64b542bb4e7b8020154bcc32a5103a15a68393565386c9c8d0e720ac605b89583c69f04401e959b6378357ba2e7567a2e2eb94c30a37e9dc41b3a32d6443d', true, NOW()),
  (2, 'operator', 'operator', 1, 'dd6ac7837c96cb876c8ec7aa5f0dc40f:ebc09281dfbfc756ca6f06d27880a55cf4c061aecc14dcbaef0d5e23b166e223bc6537e2c56f383a612d5c02d2c6de44ee8d281a7eed5668ac26dea7e1b30f25', true, NOW())
ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash;

SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM users));
SELECT setval('clients_id_seq', (SELECT COALESCE(MAX(id), 1) FROM clients));
