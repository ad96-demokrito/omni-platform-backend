import { pool, query } from "../db/pool";
import { BillingService } from "../modules/billing/billing.service";
import { computeTax } from "../modules/billing/gst";
import { toMinorUnits } from "../modules/billing/currency";
import { verifyRazorpaySignature, verifyStripeSignature } from "../modules/billing/gateways";
import crypto from "crypto";

/**
 * Read-only sanity check of the billing building blocks (plan/017). It makes NO database writes and NO
 * payment-provider calls, so it is safe to run against any environment:
 *   npm run build && node dist/scripts/verify-billing-flow.js
 * (The earlier version of this script upgraded the first tenant in the database; plan purchases are now
 * only activated from a provider-confirmed payment, so there is no write path left to exercise here.)
 */

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function main(): Promise<void> {
  // 1. Every active plan resolves with a price in each launch currency.
  for (const currency of ["INR", "USD"] as const) {
    const free = await BillingService.resolvePlan("free", currency);
    check(`free plan resolves in ${currency}`, !!free && free.priceAvailable && free.priceMonthly === 0);
  }
  const plans = await query<{ id: string }>("SELECT id FROM platform_plans WHERE is_active = true AND is_public = true");
  for (const { id } of plans) {
    for (const currency of ["INR", "USD"] as const) {
      const plan = await BillingService.resolvePlan(id, currency);
      check(`${id} has a ${currency} price`, !!plan?.priceAvailable, plan ? `${plan.priceMonthly}/mo` : "missing");
    }
  }

  // 2. Tax: India pays GST on top, everyone else pays none.
  const inr = computeTax(1499, "INR", "IN");
  check("INR 1499 + 18% GST = 1768.82", inr.taxAmount === 269.82 && inr.total === 1768.82, `${inr.taxAmount} / ${inr.total}`);
  const usd = computeTax(29, "USD", "US");
  check("USD has no tax", usd.taxAmount === 0 && usd.total === 29);
  check("minor units: INR 1768.82 -> 176882 paise", toMinorUnits(1768.82, "INR") === 176882);

  // 3. Webhook signatures reject tampering and replays.
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1" });
  const now = Math.floor(Date.now() / 1000);
  const stripeSig = (t: number, payload = body) =>
    `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  check("Stripe: valid signature accepted", verifyStripeSignature(body, stripeSig(now), secret));
  check("Stripe: tampered body rejected", !verifyStripeSignature(body + " ", stripeSig(now), secret));
  check("Stripe: old timestamp rejected (replay)", !verifyStripeSignature(body, stripeSig(now - 3600), secret));
  check("Stripe: missing header rejected", !verifyStripeSignature(body, undefined, secret));
  const rzpSig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  check("Razorpay: valid signature accepted", verifyRazorpaySignature(body, rzpSig, secret));
  check("Razorpay: wrong secret rejected", !verifyRazorpaySignature(body, rzpSig, "other"));
}

main()
  .catch((err) => {
    failures += 1;
    console.error("Billing verification crashed:", err);
  })
  .finally(async () => {
    await pool.end();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
