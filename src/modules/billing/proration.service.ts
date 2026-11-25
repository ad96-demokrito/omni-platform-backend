import { queryOne } from "../../db/pool";
import { BillingCurrency, toMinorUnits } from "./currency";

/**
 * Mid-period upgrades (plan/018, Phase D). What bigger SaaS platforms do, and what we do:
 *  - an upgrade takes effect at once and the unused time of the old plan is CREDITED, so the customer pays only the
 *    difference. For GST that is a credit note for the unused part of the old invoice plus a new invoice for the
 *    new plan in full (tax stays correct on both documents; the cash collected is the difference);
 *  - a downgrade waits until the paid period has ended (no refund, no surprise): it is refused with a clear message.
 *
 * Everything is computed in whole minor units (paise / cents) so the quote, the checkout, the provider charge and the
 * documents agree to the last paisa.
 */

export type UpgradeBlock = "lower_plan" | "credit_exceeds_price";

export interface UpgradeCredit {
  /** The invoice whose unused time is credited. */
  invoiceId: string;
  invoiceNumber: string;
  planId: string;
  periodEnd: string;
  /** Share of the old period still ahead, 0..1. */
  fraction: number;
  unusedDays: number;
  subtotal: number;
  tax: number;
  total: number;
}

export type UpgradeAssessment =
  /** Nothing to credit: no paid plan running, or the same plan and cycle (an early renewal). */
  | { kind: "no_credit" }
  | { kind: "credit"; credit: UpgradeCredit }
  | { kind: "blocked"; reason: UpgradeBlock; message: string; activeUntil: string };

interface CurrentInvoiceRow {
  id: string;
  invoice_number: string;
  plan_id: string;
  billing_cycle: string;
  amount: string;
  subtotal: string;
  tax_amount: string;
  period_start: Date;
  period_end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The smallest amount a gateway will charge (1 rupee / 1 dollar in minor units, to stay on the safe side). */
const MIN_PAYABLE_MINOR = 100;

/** What the plan costs per month, so a monthly and a yearly invoice can be compared. */
function monthlyEquivalent(subtotal: number, cycle: string, periodDays: number): number {
  if (cycle === "yearly") return subtotal / 12;
  if (cycle === "monthly") return subtotal;
  return subtotal / Math.max(1, periodDays / 30.4375);
}

export async function assessUpgrade(input: {
  tenantId: string;
  newPlanId: string;
  newBillingCycle: "monthly" | "yearly";
  /** Price of the new plan before tax, and the total including tax. */
  newSubtotal: number;
  newTotal: number;
  currency: BillingCurrency;
  now?: Date;
}): Promise<UpgradeAssessment> {
  const now = input.now ?? new Date();
  const tenant = await queryOne<{ plan: string | null; plan_status: string | null }>(
    "SELECT plan, plan_status FROM tenants WHERE id = $1",
    [input.tenantId]
  );
  if (!tenant?.plan || tenant.plan.toLowerCase() === "free" || tenant.plan_status !== "active") return { kind: "no_credit" };

  const current = await queryOne<CurrentInvoiceRow>(
    `SELECT id, invoice_number, plan_id, billing_cycle, amount, subtotal, tax_amount, period_start, period_end
     FROM platform_subscription_payments
     WHERE tenant_id = $1 AND plan_id = $2 AND status = 'paid' AND amount > 0 AND supply_type IS NOT NULL
       AND period_start <= $3 AND period_end > $3
     ORDER BY period_end DESC LIMIT 1`,
    [input.tenantId, tenant.plan.toLowerCase(), now.toISOString()]
  );
  if (!current) return { kind: "no_credit" };

  const periodStart = new Date(current.period_start).getTime();
  const periodEnd = new Date(current.period_end).getTime();
  const periodDays = (periodEnd - periodStart) / DAY_MS;
  const sameChoice = current.plan_id === input.newPlanId.toLowerCase() && current.billing_cycle === input.newBillingCycle;
  if (sameChoice) return { kind: "no_credit" }; // paying again for the same plan and cycle: an early renewal

  const oldMonthly = monthlyEquivalent(Number(current.subtotal), current.billing_cycle, periodDays);
  const newMonthly = monthlyEquivalent(input.newSubtotal, input.newBillingCycle, input.newBillingCycle === "yearly" ? 365 : 30.4375);
  const activeUntil = new Date(periodEnd).toISOString();
  const isSamePlanLongerCycle =
    current.plan_id === input.newPlanId.toLowerCase() && input.newSubtotal > Number(current.subtotal);
  if (!isSamePlanLongerCycle && !(newMonthly > oldMonthly + 0.005)) {
    return {
      kind: "blocked",
      reason: "lower_plan",
      activeUntil,
      message: "Your current plan stays active until the end of the period you paid for. You can choose a lower plan after that.",
    };
  }

  // The credit: the unused share of the old invoice (tax included), but never more than is left on it.
  const currency = input.currency;
  const fraction = Math.max(0, Math.min(1, (periodEnd - now.getTime()) / (periodEnd - periodStart)));
  const invoiceMinor = toMinorUnits(Number(current.amount), currency);
  const invoiceTaxMinor = toMinorUnits(Number(current.tax_amount), currency);
  const credited = await queryOne<{ total: string }>(
    "SELECT COALESCE(SUM(total), 0) AS total FROM billing_credit_notes WHERE invoice_id = $1",
    [current.id]
  );
  const available = invoiceMinor - toMinorUnits(Number(credited?.total ?? 0), currency);
  const creditMinor = Math.max(0, Math.min(Math.round(invoiceMinor * fraction), available));
  if (creditMinor <= 0) return { kind: "no_credit" };
  const taxMinor = Math.round((creditMinor * invoiceTaxMinor) / invoiceMinor);

  const payableMinor = toMinorUnits(input.newTotal, currency) - creditMinor;
  if (payableMinor < MIN_PAYABLE_MINOR) {
    return {
      kind: "blocked",
      reason: "credit_exceeds_price",
      activeUntil,
      message:
        "The time left on your current plan is worth about as much as this plan. Choose a larger plan, or wait until your current period ends.",
    };
  }

  return {
    kind: "credit",
    credit: {
      invoiceId: current.id,
      invoiceNumber: current.invoice_number,
      planId: current.plan_id,
      periodEnd: activeUntil,
      fraction,
      unusedDays: Math.max(0, Math.ceil((periodEnd - now.getTime()) / DAY_MS)),
      subtotal: (creditMinor - taxMinor) / 100,
      tax: taxMinor / 100,
      total: creditMinor / 100,
    },
  };
}
