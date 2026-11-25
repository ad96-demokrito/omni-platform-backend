-- 022: plan feature flags (plan/017, Phase 4).
--
-- Requires 013 (platform_plans). Additive: no existing column is changed.
--
-- A plan now says which gated features it includes, as { "<flag>": true } (a missing flag = not included):
--   ai_copilot        AI Copilot, knowledge bases / RAG, the AI Agent and Intent Router flow nodes
--   api_keys          developer API keys (creating them, and authenticating with them)
--   audit_compliance  audit-trail viewer and the GDPR / data-deletion tools (events are always recorded)
--   teams_roles       support teams and routing, plus choosing a role other than "agent" for members
-- The free-text `features` list stays display-only.
--
-- Rollback (manual): ALTER TABLE platform_plans DROP COLUMN IF EXISTS feature_flags;

ALTER TABLE platform_plans
  ADD COLUMN IF NOT EXISTS feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Tiered defaults. Only plans that have no flags yet are seeded, so re-running changes nothing, and an admin's
-- later edits are never overwritten. Free stays empty on purpose.
UPDATE platform_plans
SET feature_flags = CASE id
  WHEN 'starter' THEN '{"ai_copilot": true}'::jsonb
  -- Pro, Enterprise and any other / custom plan (for example a hand-made one): keep every feature they have today.
  ELSE '{"ai_copilot": true, "api_keys": true, "audit_compliance": true, "teams_roles": true}'::jsonb
END
WHERE feature_flags = '{}'::jsonb
  AND id <> 'free';
