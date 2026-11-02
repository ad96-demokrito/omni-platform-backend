-- 018_plans_inr_currency.sql
-- Switch platform billing from USD to INR (rupees)

ALTER TABLE platform_plans ALTER COLUMN currency SET DEFAULT 'INR';

UPDATE platform_plans SET currency = 'INR' WHERE currency = 'USD';

-- Standard tiers repriced for INR (custom/test plans keep their amounts)
UPDATE platform_plans SET price_monthly = 2499,  price_yearly = 24990  WHERE id = 'starter';
UPDATE platform_plans SET price_monthly = 7999,  price_yearly = 79990  WHERE id = 'pro';
UPDATE platform_plans SET price_monthly = 24999, price_yearly = 249990 WHERE id = 'enterprise';
