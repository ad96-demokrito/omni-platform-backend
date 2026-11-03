import { pool, query } from "../db/pool";
import { normalizeDripSteps } from "../modules/campaigns/campaigns.types";

/**
 * One-off repair for drip campaigns created before the `message` -> `text` fix and the explicit
 * "Start drip" flow:
 *   1. rewrites saved steps from { message } to { delayHours, text };
 *   2. puts recipients that failed with "text.body is required" back to pending, to resend;
 *   3. marks drips that were already running (a recipient past step 1, or reset above) as
 *      'sending' so the scheduler, which now only works on 'sending' drips, keeps going.
 * Drips that never started stay 'draft' and wait for an explicit Start.
 *
 *   npm run repair:drips                       # dry run, changes nothing
 *   npm run repair:drips -- --apply            # write the changes
 *   npm run repair:drips -- --apply --tenant <tenantId>
 *
 * In production use the compiled script: node dist/scripts/repair-drip-campaigns.js --apply
 */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface DripRow {
  id: string;
  definition: { steps?: unknown };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = argValue("--tenant") ?? null;

  const drips = await query<DripRow>(
    `SELECT id, definition FROM campaigns
      WHERE type = 'drip' AND ($1::uuid IS NULL OR tenant_id = $1)`,
    [tenantId]
  );

  let stepsToRewrite = 0;
  let invalidDefinitions = 0;
  for (const drip of drips) {
    const normalized = normalizeDripSteps(drip.definition?.steps);
    if ("error" in normalized) {
      invalidDefinitions++;
      console.warn(`  campaign ${drip.id} skipped: ${normalized.error}`);
      continue;
    }
    if (JSON.stringify(normalized.steps) === JSON.stringify(drip.definition.steps)) continue;
    stepsToRewrite++;
    if (apply) {
      await query(
        "UPDATE campaigns SET definition = jsonb_set(definition, '{steps}', $2::jsonb) WHERE id = $1",
        [drip.id, JSON.stringify(normalized.steps)]
      );
    }
  }

  // Decide which draft drips were already running BEFORE touching recipients, so the dry run and
  // --apply report the same numbers: a recipient past step 1, or one that failed on the empty text.
  const toResume = await query<{ id: string }>(
    `SELECT DISTINCT c.id FROM campaigns c
       JOIN campaign_recipients cr ON cr.campaign_id = c.id
      WHERE c.type = 'drip' AND c.status = 'draft'
        AND ($1::uuid IS NULL OR c.tenant_id = $1)
        AND (cr.current_step > 0
             OR (cr.status = 'failed' AND cr.last_error ILIKE '%text.body%'))`,
    [tenantId]
  );

  const failedOnEmptyText = `cr.status = 'failed' AND cr.last_error ILIKE '%text.body%'`;
  let resetCount: number;
  if (apply) {
    const reset = await query<{ id: string }>(
      `UPDATE campaign_recipients cr
          SET status = 'pending', last_error = NULL, next_send_at = now(), updated_at = now()
         FROM campaigns c
        WHERE c.id = cr.campaign_id AND c.type = 'drip'
          AND ($1::uuid IS NULL OR c.tenant_id = $1)
          AND ${failedOnEmptyText}
      RETURNING cr.id`,
      [tenantId]
    );
    resetCount = reset.length;
    if (toResume.length > 0) {
      await query("UPDATE campaigns SET status = 'sending' WHERE id = ANY($1::uuid[])", [
        toResume.map((row) => row.id),
      ]);
    }
  } else {
    const wouldReset = await query<{ id: string }>(
      `SELECT cr.id FROM campaign_recipients cr
         JOIN campaigns c ON c.id = cr.campaign_id
        WHERE c.type = 'drip' AND ($1::uuid IS NULL OR c.tenant_id = $1)
          AND ${failedOnEmptyText}`,
      [tenantId]
    );
    resetCount = wouldReset.length;
  }

  console.log(apply ? "Repair applied:" : "Dry run (no changes written, pass --apply to write):");
  console.log(`  drip campaigns checked:                        ${drips.length}`);
  console.log(`  saved steps rewritten to { delayHours, text }: ${stepsToRewrite}`);
  console.log(`  campaigns skipped (invalid steps):             ${invalidDefinitions}`);
  console.log(`  recipients reset from "text.body" failure:     ${resetCount}`);
  console.log(`  draft drips resumed as 'sending':              ${toResume.length}`);
}

main()
  .catch((err) => {
    console.error("Repair failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
