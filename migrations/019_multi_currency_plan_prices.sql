-- 019: per-currency plan prices + tenant billing country/currency (plan/017, Phase 1).
--
-- Additive and rollback-safe: platform_plans.price_monthly / price_yearly / currency are kept
-- (legacy, still returned to old clients); new code reads platform_plan_prices.
--
-- !! The INR prices below are a DRAFT rate card from plan/017. Confirm them before applying this
-- !! migration to a database that serves customers (prices can also be edited later in the admin
-- !! Plans page, so this only affects the initial values).
--
-- Rollback (manual, in this order):
--   DROP TABLE IF EXISTS platform_plan_prices;
--   ALTER TABLE tenants
--     DROP COLUMN IF EXISTS billing_country,  DROP COLUMN IF EXISTS billing_currency,
--     DROP COLUMN IF EXISTS billing_tax_id,   DROP COLUMN IF EXISTS billing_name,
--     DROP COLUMN IF EXISTS billing_address,  DROP COLUMN IF EXISTS currency_locked_at;

CREATE TABLE IF NOT EXISTS platform_plan_prices (
  plan_id       TEXT         NOT NULL REFERENCES platform_plans(id) ON DELETE CASCADE,
  currency      CHAR(3)      NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_monthly NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  price_yearly  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price_yearly >= 0),
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, currency)
);

-- Existing single price of every plan becomes its row in that plan's own currency (USD for the seeds).
INSERT INTO platform_plan_prices (plan_id, currency, price_monthly, price_yearly)
SELECT id, upper(currency), price_monthly, price_yearly
FROM platform_plans
WHERE currency ~ '^[A-Za-z]{3}$'
ON CONFLICT (plan_id, currency) DO NOTHING;

-- DRAFT INR rate card for the four seeded plans (exclusive of 18% GST, which is added at checkout).
INSERT INTO platform_plan_prices (plan_id, currency, price_monthly, price_yearly)
SELECT v.plan_id, 'INR', v.price_monthly, v.price_yearly
FROM (VALUES
  ('free',        0::numeric,     0::numeric),
  ('starter',     1499::numeric,  14990::numeric),
  ('pro',         4999::numeric,  49990::numeric),
  ('enterprise',  14999::numeric, 149990::numeric)
) AS v(plan_id, price_monthly, price_yearly)
WHERE EXISTS (SELECT 1 FROM platform_plans p WHERE p.id = v.plan_id)
ON CONFLICT (plan_id, currency) DO NOTHING;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS billing_country    CHAR(2),
  ADD COLUMN IF NOT EXISTS billing_currency   CHAR(3),
  ADD COLUMN IF NOT EXISTS billing_tax_id     TEXT,
  ADD COLUMN IF NOT EXISTS billing_name       TEXT,
  ADD COLUMN IF NOT EXISTS billing_address    JSONB,
  -- Set on the first paid payment; after that the billing country/currency can only be changed by platform staff.
  ADD COLUMN IF NOT EXISTS currency_locked_at TIMESTAMPTZ;

-- Existing workspaces were onboarded in India. Assumption from plan/017: confirm before applying.
UPDATE tenants
SET billing_country = 'IN', billing_currency = 'INR'
WHERE billing_country IS NULL AND billing_currency IS NULL;
