-- 013_plans_subscriptions_and_support_tickets.sql
-- Dynamic Plans, Subscription Payment Ledger, and Helpdesk Support Ticketing System

-- ─────────────────────────────────────────────────────────────
-- 1. Dynamic Platform Plans Table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_plans (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  description             TEXT,
  price_monthly           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  price_yearly            NUMERIC(10, 2) NOT NULL DEFAULT 0,
  currency                TEXT NOT NULL DEFAULT 'INR',
  max_channels            INTEGER NOT NULL DEFAULT 1,
  max_contacts            INTEGER NOT NULL DEFAULT 500,
  max_monthly_messages    INTEGER NOT NULL DEFAULT 2000,
  max_monthly_ai_queries  INTEGER NOT NULL DEFAULT 100,
  features                JSONB NOT NULL DEFAULT '[]',
  badge_text              TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  is_public               BOOLEAN NOT NULL DEFAULT true,
  is_custom               BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure all columns exist in case table was previously created with minimal schema
ALTER TABLE platform_plans
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS price_monthly NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_yearly NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS max_channels INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_contacts INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS max_monthly_messages INTEGER NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS max_monthly_ai_queries INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS badge_text TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_platform_plans_active ON platform_plans (is_active);
CREATE INDEX IF NOT EXISTS idx_platform_plans_public ON platform_plans (is_public);

-- Seed baseline standard platform plans
INSERT INTO platform_plans (id, name, description, price_monthly, price_yearly, currency, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries, features, badge_text, is_active, is_public, is_custom)
VALUES
  (
    'free',
    'Free Sandbox',
    'Essential tools for evaluation, local sandbox testing, and proof of concept.',
    0.00,
    0.00,
    'INR',
    1,
    500,
    2000,
    100,
    '["1 Active Channel", "500 Total Contacts", "2,000 Messages / mo", "100 AI Copilot Queries / mo", "Community Support", "Basic Flow Builder"]'::jsonb,
    'Sandbox',
    true,
    true,
    false
  ),
  (
    'starter',
    'Starter Growth',
    'Perfect for scaling boutique stores, direct-to-consumer brands, and growing teams.',
    29.00,
    290.00,
    'INR',
    3,
    3000,
    15000,
    500,
    '["3 Connected Channels", "3,000 Total Contacts", "15,000 Messages / mo", "500 AI Copilot Queries / mo", "Standard Support SLA (24h)", "Visual Flow Automation Engine", "Payment Links & Invoicing"]'::jsonb,
    'Popular',
    true,
    true,
    false
  ),
  (
    'pro',
    'Pro Scale',
    'High-throughput omnichannel engine for multi-agent support and hyper-growth enterprises.',
    99.00,
    990.00,
    'INR',
    10,
    25000,
    100000,
    5000,
    '["10 Connected Channels", "25,000 Total Contacts", "100,000 Messages / mo", "5,000 AI Copilot Queries / mo", "Priority Support SLA (4h)", "Full CRM & E-Commerce Catalog", "Real-Time WebSocket Infras", "Unlimited Visual Flows"]'::jsonb,
    'Scale',
    true,
    true,
    false
  ),
  (
    'enterprise',
    'Enterprise Custom',
    'Dedicated high-availability multi-tenant governance, custom SLAs, and custom limits.',
    299.00,
    2990.00,
    'INR',
    50,
    500000,
    1000000,
    50000,
    '["50+ Connected Channels", "500,000 Total Contacts", "1,000,000 Messages / mo", "50,000 AI Copilot Queries / mo", "Dedicated Account Manager & 1h SLA", "Zero-PII Privacy Shield Compliance", "Custom Webhooks & API Ingestion", "Custom Role RBAC"]'::jsonb,
    'Enterprise',
    true,
    true,
    false
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_monthly = EXCLUDED.price_monthly,
  price_yearly = EXCLUDED.price_yearly,
  max_channels = EXCLUDED.max_channels,
  max_contacts = EXCLUDED.max_contacts,
  max_monthly_messages = EXCLUDED.max_monthly_messages,
  max_monthly_ai_queries = EXCLUDED.max_monthly_ai_queries,
  features = EXCLUDED.features,
  badge_text = EXCLUDED.badge_text,
  is_active = EXCLUDED.is_active,
  is_public = EXCLUDED.is_public;

-- ─────────────────────────────────────────────────────────────
-- 2. Platform Subscription Payments & Invoices Ledger
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_subscription_payments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id                 TEXT NOT NULL,
  plan_name               TEXT NOT NULL,
  amount                  NUMERIC(10, 2) NOT NULL DEFAULT 0,
  currency                TEXT NOT NULL DEFAULT 'INR',
  billing_cycle           TEXT NOT NULL DEFAULT 'monthly',
  payment_method          TEXT NOT NULL DEFAULT 'stripe',
  transaction_reference   TEXT,
  status                  TEXT NOT NULL DEFAULT 'paid',
  invoice_number          TEXT NOT NULL UNIQUE,
  period_start            TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_end              TIMESTAMPTZ NOT NULL,
  notes                   TEXT,
  recorded_by_staff_id    UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  recorded_by_name        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_payments_tenant ON platform_subscription_payments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sub_payments_status ON platform_subscription_payments (status);
CREATE INDEX IF NOT EXISTS idx_sub_payments_created ON platform_subscription_payments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_payments_invoice ON platform_subscription_payments (invoice_number);

-- ─────────────────────────────────────────────────────────────
-- 3. Support Tickets & Case Management
-- ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS support_ticket_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS support_tickets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number         TEXT NOT NULL UNIQUE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_email      TEXT NOT NULL,
  created_by_name       TEXT NOT NULL,
  subject               TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'general',
  priority              TEXT NOT NULL DEFAULT 'medium',
  status                TEXT NOT NULL DEFAULT 'open',
  assigned_to_staff_id  UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  assigned_to_name      TEXT,
  last_reply_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets (tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets (priority);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned ON support_tickets (assigned_to_staff_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_last_reply ON support_tickets (last_reply_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 4. Support Ticket Messages & Staff Internal Notes
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id             UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type           TEXT NOT NULL,
  sender_id             UUID,
  sender_name           TEXT NOT NULL,
  sender_email          TEXT NOT NULL,
  message               TEXT NOT NULL,
  attachments           JSONB NOT NULL DEFAULT '[]',
  is_internal_note      BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON support_ticket_messages (ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_created ON support_ticket_messages (created_at DESC);
