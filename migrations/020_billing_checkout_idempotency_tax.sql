-- 020: checkout sessions, webhook idempotency, GST/tax on the ledger, invoice sequence (plan/017, Phase 2).
--
-- Requires 019 (tenant billing columns). Additive: existing ledger rows keep working (tax columns default to 0,
-- subtotal is backfilled from amount).
--
-- Rollback (manual, in this order):
--   DROP TABLE IF EXISTS billing_checkout_sessions;
--   DROP TABLE IF EXISTS payment_webhook_events;
--   DROP INDEX IF EXISTS uq_sub_payments_gateway_payment;
--   DROP SEQUENCE IF EXISTS platform_invoice_seq;
--   ALTER TABLE platform_subscription_payments
--     DROP COLUMN IF EXISTS gateway, DROP COLUMN IF EXISTS gateway_payment_id, DROP COLUMN IF EXISTS subtotal,
--     DROP COLUMN IF EXISTS tax_amount, DROP COLUMN IF EXISTS tax_rate, DROP COLUMN IF EXISTS tax_label,
--     DROP COLUMN IF EXISTS buyer_tax_id, DROP COLUMN IF EXISTS seller_tax_id;

-- A checkout is created by US with the price we computed; the browser and the gateway never decide the amount.
-- Payment confirmations (webhook or status poll) are matched to this row and checked against it.
CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gateway            TEXT NOT NULL CHECK (gateway IN ('stripe', 'razorpay', 'sandbox')),
  -- Stripe Checkout Session id (cs_...) or Razorpay payment link id (plink_...)
  gateway_session_id TEXT NOT NULL,
  plan_id            TEXT NOT NULL,
  billing_cycle      TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  currency           CHAR(3) NOT NULL,
  subtotal           NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  tax_amount         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  tax_rate           NUMERIC(5,2)  NOT NULL DEFAULT 0,
  total              NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  buyer_tax_id       TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  payment_id         UUID REFERENCES platform_subscription_payments(id) ON DELETE SET NULL,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at            TIMESTAMPTZ,
  UNIQUE (gateway, gateway_session_id)
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_tenant ON billing_checkout_sessions (tenant_id, created_at DESC);

-- Every gateway event is recorded once; a redelivery of an event that was fully processed is ignored.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  gateway      TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (gateway, event_id)
);

ALTER TABLE platform_subscription_payments
  ADD COLUMN IF NOT EXISTS gateway            TEXT,
  ADD COLUMN IF NOT EXISTS gateway_payment_id TEXT,
  -- amount stays the TOTAL charged (subtotal + tax_amount).
  ADD COLUMN IF NOT EXISTS subtotal           NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS tax_amount         NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate           NUMERIC(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_label          TEXT,
  ADD COLUMN IF NOT EXISTS buyer_tax_id       TEXT,
  ADD COLUMN IF NOT EXISTS seller_tax_id      TEXT;

UPDATE platform_subscription_payments SET subtotal = amount WHERE subtotal IS NULL;

-- The same gateway payment can never be recorded twice (safety net behind the webhook/poll race).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_payments_gateway_payment
  ON platform_subscription_payments (gateway, gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;

-- Invoice numbers come from a sequence (the old count+random suffix could collide under concurrency).
-- A sequence can skip numbers after a rolled-back transaction: confirm GST numbering rules with an accountant.
CREATE SEQUENCE IF NOT EXISTS platform_invoice_seq START 1;
