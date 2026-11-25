-- 025: credit notes and upgrade credit (plan/018, Phase D).
--
-- Requires 020 (checkout sessions), 021 (subscriptions), 023 (GST invoices). Additive.
--
-- GST needs a CREDIT NOTE whenever an invoiced value is reduced or refunded: a document with its own consecutive
-- number (series `CN/26-27/000001`) that points at the original invoice and reverses the tax. We also use one when a
-- customer upgrades mid-period: the unused part of the old invoice is credited (credit note) and the new plan is
-- invoiced in full, so GST stays correct on both documents and the customer only pays the difference.
--
-- Rollback (manual, in this order):
--   ALTER TABLE tenant_subscriptions DROP COLUMN IF EXISTS superseded_at;
--   ALTER TABLE platform_subscription_payments DROP COLUMN IF EXISTS credit_applied;
--   ALTER TABLE billing_checkout_sessions
--     DROP COLUMN IF EXISTS credit_invoice_id, DROP COLUMN IF EXISTS credit_subtotal,
--     DROP COLUMN IF EXISTS credit_tax, DROP COLUMN IF EXISTS credit_total;
--   DROP TABLE IF EXISTS billing_credit_notes;

CREATE TABLE IF NOT EXISTS billing_credit_notes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credit_note_number    TEXT NOT NULL UNIQUE,
  -- The invoice being reduced.
  invoice_id            UUID NOT NULL REFERENCES platform_subscription_payments(id),
  kind                  TEXT NOT NULL CHECK (kind IN ('upgrade_credit', 'refund', 'cancellation', 'correction')),
  reason                TEXT NOT NULL,
  currency              CHAR(3) NOT NULL,
  -- Positive numbers; the register and the PDF show them as a reduction.
  subtotal              NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  tax_rate              NUMERIC(5,2)  NOT NULL DEFAULT 0,
  cgst_amount           NUMERIC(10,2) NOT NULL DEFAULT 0,
  sgst_amount           NUMERIC(10,2) NOT NULL DEFAULT 0,
  igst_amount           NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  total                 NUMERIC(10,2) NOT NULL CHECK (total > 0),
  -- The new invoice this credit was applied to (an upgrade); NULL for a refund paid back to the customer.
  applied_to_invoice_id UUID REFERENCES platform_subscription_payments(id),
  -- Seller and buyer as printed (copied from the original invoice).
  seller_name           TEXT,
  seller_address        TEXT,
  seller_state_code     CHAR(2),
  seller_tax_id         TEXT,
  buyer_name            TEXT,
  buyer_address         TEXT,
  buyer_state_code      CHAR(2),
  buyer_tax_id          TEXT,
  place_of_supply       TEXT,
  sac_code              TEXT,
  supply_type           TEXT CHECK (supply_type IN ('b2b', 'b2c', 'export')),
  lut_number            TEXT,
  issued_by             TEXT NOT NULL DEFAULT 'system',
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  pdf_key               TEXT,
  pdf_sha256            TEXT,
  email_status          TEXT NOT NULL DEFAULT 'none' CHECK (email_status IN ('none', 'pending', 'sent', 'failed')),
  email_attempts        INTEGER NOT NULL DEFAULT 0,
  email_last_error      TEXT,
  emailed_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_tenant ON billing_credit_notes (tenant_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON billing_credit_notes (invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_issued ON billing_credit_notes (issued_at);
CREATE INDEX IF NOT EXISTS idx_credit_notes_email_retry ON billing_credit_notes (email_status)
  WHERE email_status IN ('pending', 'failed');

-- An upgrade: the credit the customer gets for the unused part of the old invoice is fixed when the checkout starts
-- (like the price), so what the gateway charges is exactly what we stored.
ALTER TABLE billing_checkout_sessions
  ADD COLUMN IF NOT EXISTS credit_invoice_id UUID REFERENCES platform_subscription_payments(id),
  ADD COLUMN IF NOT EXISTS credit_subtotal   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_subtotal >= 0),
  ADD COLUMN IF NOT EXISTS credit_tax        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_tax >= 0),
  ADD COLUMN IF NOT EXISTS credit_total      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_total >= 0);

-- On the new invoice: how much credit was applied. Cash collected = amount - credit_applied.
ALTER TABLE platform_subscription_payments
  ADD COLUMN IF NOT EXISTS credit_applied NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (credit_applied >= 0);

-- A subscription that an upgrade replaced. If cancelling it at the provider failed, this marks it so that a charge
-- on it is never applied as a renewal, and the hourly job keeps retrying the cancellation.
ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
