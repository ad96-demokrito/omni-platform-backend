-- ─────────────────────────────────────────────────────────────
-- Human hand-off from the flow builder
--
--   * conversations.bot_paused: explicit "a human owns this case" flag. Until now the pause was only
--     inferred from flow_runs.status = 'handed_off', so assigning/claiming a case did not stop the bot.
--   * conversations.handoff_*: why/when/by which flow the case was handed to a human, so agents can see it.
--   * tenants.auto_assign_enabled: workspace switch; when on, a hand-off is assigned to the least busy agent.
--   * users.last_auto_assigned_at: tie-breaker for the least-busy picker.
--
-- All ADD COLUMN statements use constant defaults (no table rewrite on PG 11+).
-- The index is built plainly; for a very large conversations table create it CONCURRENTLY by hand first
-- (it is IF NOT EXISTS, so this file then skips it).
--
-- Rollback: DROP INDEX IF EXISTS conversations_tenant_handoff_idx;
--           ALTER TABLE conversations DROP COLUMN IF EXISTS bot_paused, DROP COLUMN IF EXISTS handoff_at,
--             DROP COLUMN IF EXISTS handoff_reason, DROP COLUMN IF EXISTS handoff_priority,
--             DROP COLUMN IF EXISTS handoff_context, DROP COLUMN IF EXISTS handoff_flow_name;
--           ALTER TABLE tenants DROP COLUMN IF EXISTS auto_assign_enabled;
--           ALTER TABLE users DROP COLUMN IF EXISTS last_auto_assigned_at;
--           (leaving the columns in place is harmless: the previous release ignores them)
-- ─────────────────────────────────────────────────────────────

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_paused        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS handoff_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handoff_reason    TEXT,
  ADD COLUMN IF NOT EXISTS handoff_priority  TEXT,
  ADD COLUMN IF NOT EXISTS handoff_context   JSONB,
  ADD COLUMN IF NOT EXISTS handoff_flow_name TEXT;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS auto_assign_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_auto_assigned_at TIMESTAMPTZ;

-- Cases that were already handed to a human keep the bot paused after this deploy.
UPDATE conversations c
SET bot_paused = true
WHERE c.status <> 'closed'
  AND c.bot_paused = false
  AND EXISTS (
    SELECT 1 FROM flow_runs fr
    WHERE fr.conversation_id = c.id AND fr.status = 'handed_off'
  );

-- Pending/hand-off queue lookups per tenant.
CREATE INDEX IF NOT EXISTS conversations_tenant_handoff_idx
  ON conversations (tenant_id, handoff_at)
  WHERE status <> 'closed' AND handoff_at IS NOT NULL;

COMMENT ON COLUMN conversations.bot_paused IS 'true while a human owns the case; flow engine skips inbound messages';
COMMENT ON COLUMN conversations.handoff_priority IS 'normal | high | urgent';
