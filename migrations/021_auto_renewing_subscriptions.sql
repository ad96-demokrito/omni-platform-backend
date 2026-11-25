-- 021: auto-renewing subscriptions (plan/017, Phase 3).
--
-- Requires 019 and 020. Additive: existing workspaces and ledger rows are untouched.
--
-- Rollback (manual, in this order):
--   DROP TABLE IF EXISTS tenant_subscriptions;
--   DROP TABLE IF EXISTS billing_gateway_plans;
--   ALTER TABLE billing_checkout_sessions DROP COLUMN IF EXISTS mode;
--   ALTER TABLE tenants DROP COLUMN IF EXISTS stripe_customer_id, DROP COLUMN IF EXISTS expiry_reminder_for;

ALTER TABLE tenants
  -- Stripe customer, needed to open the card-management portal.
  ADD COLUMN IF NOT EXISTS stripe_customer_id  TEXT,
  -- The plan_expires_at value we already sent a "your plan ends soon" email for (stops repeat emails).
  ADD COLUMN IF NOT EXISTS expiry_reminder_for TIMESTAMPTZ;

-- A checkout either takes one payment (the Phase 2 behaviour) or starts a subscription that renews by itself.
ALTER TABLE billing_checkout_sessions
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'payment' CHECK (mode IN ('payment', 'subscription'));

-- One row per subscription that has been PAID at least once. Its price is locked at signup: a later change of the
-- plan price does not alter what an existing subscriber is charged.
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  checkout_id             UUID REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL,
  gateway                 TEXT NOT NULL CHECK (gateway IN ('stripe', 'razorpay', 'sandbox')),
  gateway_subscription_id TEXT NOT NULL,
  gateway_customer_id     TEXT,
  plan_id                 TEXT NOT NULL,
  billing_cycle           TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  currency                CHAR(3) NOT NULL,
  -- What every renewal charges (subtotal + tax = total), fixed when the subscription started.
  subtotal                NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  tax_amount              NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  tax_rate                NUMERIC(5,2)  NOT NULL DEFAULT 0,
  total                   NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  buyer_tax_id            TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
  -- Cancelled by the customer: keeps renewing nothing, stays active until the period they paid for ends.
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT false,
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  last_payment_at         TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_subscription_id)
);

-- A workspace has at most one live subscription.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_live_subscription
  ON tenant_subscriptions (tenant_id) WHERE status IN ('active', 'past_due');
CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_tenant ON tenant_subscriptions (tenant_id, created_at DESC);

-- Razorpay needs a "plan" object per (price, cycle); reuse it instead of creating one per checkout.
CREATE TABLE IF NOT EXISTS billing_gateway_plans (
  gateway         TEXT NOT NULL,
  plan_id         TEXT NOT NULL,
  billing_cycle   TEXT NOT NULL,
  currency        CHAR(3) NOT NULL,
  amount_minor    BIGINT NOT NULL,
  gateway_plan_id TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway, plan_id, billing_cycle, currency, amount_minor)
);
