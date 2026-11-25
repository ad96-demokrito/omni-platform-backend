-- 024: read-only `finance` role for the accountant (plan/018, Phase C).
--
-- Requires 012 (platform_users). A finance login can only view the payments ledger and download invoices and the
-- monthly GST package; everything else in the platform API is refused (see middleware/platform-auth.ts).
--
-- Rollback (manual): move or delete any finance users first, then
--   ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_role_check;
--   ALTER TABLE platform_users ADD CONSTRAINT platform_users_role_check
--     CHECK (role IN ('super_admin', 'platform_dev', 'platform_tester', 'support_agent'));

DO $$
DECLARE
  existing text;
BEGIN
  -- The original CHECK was created inline in 012, so its name is generated: find it by what it checks.
  FOR existing IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'platform_users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%super_admin%'
  LOOP
    EXECUTE format('ALTER TABLE platform_users DROP CONSTRAINT %I', existing);
  END LOOP;

  ALTER TABLE platform_users
    ADD CONSTRAINT platform_users_role_check
    CHECK (role IN ('super_admin', 'platform_dev', 'platform_tester', 'support_agent', 'finance'));
END $$;
