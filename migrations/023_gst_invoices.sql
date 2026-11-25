-- 023: GST-correct tax invoices (plan/018, Phases A and B).
--
-- Requires 019/020 (tenant billing columns, ledger tax columns). Additive: existing ledger rows are untouched; a row
-- with supply_type IS NULL is a LEGACY invoice (issued before this migration, no seller/buyer snapshot).
--
-- What this adds
--   * invoice_counters: one gapless counter per document type and financial year (Apr-Mar, India time). A number is
--     allocated with UPDATE .. RETURNING inside the same transaction that inserts the document, so a rolled-back insert
--     gives the number back (a plain sequence cannot do that). Format: INV/26-27/000123 (16 characters).
--   * the invoice row (platform_subscription_payments) gets an immutable snapshot of seller and buyer as they were at
--     issue time, the CGST/SGST/IGST split, the place of supply, the PDF location and the email delivery status.
--   * tenants.billing_state_code: the customer's GST state code, which decides CGST+SGST (same state as the seller)
--     or IGST (other state).
--
-- Rollback (manual, in this order):
--   ALTER TABLE platform_subscription_payments
--     DROP COLUMN IF EXISTS seller_name, DROP COLUMN IF EXISTS seller_address, DROP COLUMN IF EXISTS seller_state_code,
--     DROP COLUMN IF EXISTS buyer_name, DROP COLUMN IF EXISTS buyer_address, DROP COLUMN IF EXISTS buyer_state_code,
--     DROP COLUMN IF EXISTS place_of_supply, DROP COLUMN IF EXISTS sac_code, DROP COLUMN IF EXISTS cgst_amount,
--     DROP COLUMN IF EXISTS sgst_amount, DROP COLUMN IF EXISTS igst_amount, DROP COLUMN IF EXISTS supply_type,
--     DROP COLUMN IF EXISTS lut_number, DROP COLUMN IF EXISTS issued_at, DROP COLUMN IF EXISTS pdf_key,
--     DROP COLUMN IF EXISTS pdf_sha256, DROP COLUMN IF EXISTS email_status, DROP COLUMN IF EXISTS email_attempts,
--     DROP COLUMN IF EXISTS email_last_error, DROP COLUMN IF EXISTS emailed_at;
--   ALTER TABLE tenants DROP COLUMN IF EXISTS billing_state_code;
--   DROP TABLE IF EXISTS invoice_counters;

CREATE TABLE IF NOT EXISTS invoice_counters (
  document_type  TEXT    NOT NULL CHECK (document_type IN ('invoice', 'credit_note')),
  -- Financial year as printed in the number, for example '26-27' (1 April 2026 .. 31 March 2027).
  financial_year TEXT    NOT NULL,
  last_number    INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (document_type, financial_year)
);

ALTER TABLE tenants
  -- Two-digit GST state code (07 = Delhi, 27 = Maharashtra, ...). Chosen by the customer or taken from the GSTIN.
  ADD COLUMN IF NOT EXISTS billing_state_code CHAR(2);

-- A GSTIN starts with the state code, so existing customers who already entered one need no extra step.
UPDATE tenants
SET billing_state_code = substr(billing_tax_id, 1, 2)
WHERE billing_state_code IS NULL
  AND billing_tax_id ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';

ALTER TABLE platform_subscription_payments
  -- Seller and buyer exactly as printed on the invoice. Never read from the live tenant row again.
  ADD COLUMN IF NOT EXISTS seller_name       TEXT,
  ADD COLUMN IF NOT EXISTS seller_address    TEXT,
  ADD COLUMN IF NOT EXISTS seller_state_code CHAR(2),
  ADD COLUMN IF NOT EXISTS buyer_name        TEXT,
  ADD COLUMN IF NOT EXISTS buyer_address     TEXT,
  ADD COLUMN IF NOT EXISTS buyer_state_code  CHAR(2),
  ADD COLUMN IF NOT EXISTS place_of_supply   TEXT,
  ADD COLUMN IF NOT EXISTS sac_code          TEXT,
  -- tax_amount stays the TOTAL tax; these split it (they add up to tax_amount).
  ADD COLUMN IF NOT EXISTS cgst_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- NULL = legacy invoice. 'b2b' = buyer gave a GSTIN, 'b2c' = no GSTIN, 'export' = supplied outside India.
  ADD COLUMN IF NOT EXISTS supply_type       TEXT CHECK (supply_type IN ('b2b', 'b2c', 'export')),
  ADD COLUMN IF NOT EXISTS lut_number        TEXT,
  ADD COLUMN IF NOT EXISTS issued_at         TIMESTAMPTZ,
  -- The PDF is rendered once at issue time and stored; it is never regenerated.
  ADD COLUMN IF NOT EXISTS pdf_key           TEXT,
  ADD COLUMN IF NOT EXISTS pdf_sha256        TEXT,
  ADD COLUMN IF NOT EXISTS email_status      TEXT NOT NULL DEFAULT 'none'
    CHECK (email_status IN ('none', 'pending', 'sent', 'failed')),
  ADD COLUMN IF NOT EXISTS email_attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_last_error  TEXT,
  ADD COLUMN IF NOT EXISTS emailed_at        TIMESTAMPTZ;

-- The monthly export for the accountant filters by issue date; the retry job looks for failed/pending emails.
CREATE INDEX IF NOT EXISTS idx_sub_payments_issued ON platform_subscription_payments (issued_at);
CREATE INDEX IF NOT EXISTS idx_sub_payments_email_retry ON platform_subscription_payments (email_status)
  WHERE email_status IN ('pending', 'failed');
