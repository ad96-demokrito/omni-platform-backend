import { gstRatePercent } from "./config";
import { BillingCurrency, toMinorUnits } from "./currency";
import { stateName } from "./gst-states";

/**
 * Tax on a subscription charge. Prices are exclusive of tax (plan/017): India (INR) pays GST on top, everyone else
 * is an export of services with no GST (foreign VAT/sales tax is an accounting question, not handled in code).
 *
 * The GST rate is an env value (GST_RATE_PERCENT). Where the tax goes depends on the place of supply (plan/018):
 * a customer in the SAME state as the seller pays CGST + SGST (half the rate each), any other state pays IGST.
 */
export type SupplyType = "b2b" | "b2c" | "export";

export interface TaxBreakdown {
  subtotal: number;
  /** Total tax = cgst + sgst + igst. */
  taxAmount: number;
  /** Percent, 0 when no tax applies. */
  taxRate: number;
  taxLabel: string | null;
  /** What the customer is charged: subtotal + tax. */
  total: number;
  cgst: number;
  sgst: number;
  igst: number;
  supplyType: SupplyType;
  buyerStateCode: string | null;
  /** State name printed as "Place of supply" (null for an export). */
  placeOfSupply: string | null;
}

export interface TaxContext {
  buyerStateCode?: string | null;
  sellerStateCode?: string | null;
  /** The buyer's GSTIN: its presence makes the supply B2B. */
  buyerTaxId?: string | null;
}

export function isSameState(buyerStateCode: string | null | undefined, sellerStateCode: string | null | undefined): boolean {
  return Boolean(buyerStateCode && sellerStateCode && buyerStateCode.trim() === sellerStateCode.trim());
}

/**
 * Splits an ALREADY FIXED total tax into its parts (used when the amount was charged earlier, for example at a
 * renewal): same state -> CGST + SGST (SGST takes the odd paisa), otherwise all IGST.
 */
export function splitTaxAmount(
  taxAmount: number,
  currency: BillingCurrency,
  sameState: boolean
): { cgst: number; sgst: number; igst: number } {
  if (taxAmount <= 0) return { cgst: 0, sgst: 0, igst: 0 };
  if (!sameState) return { cgst: 0, sgst: 0, igst: taxAmount };
  const taxMinor = toMinorUnits(taxAmount, currency);
  const cgstMinor = Math.floor(taxMinor / 2);
  return { cgst: cgstMinor / 100, sgst: (taxMinor - cgstMinor) / 100, igst: 0 };
}

export function computeTax(
  subtotal: number,
  currency: BillingCurrency,
  country: string | null,
  context: TaxContext = {}
): TaxBreakdown {
  const isIndian = currency === "INR" && country === "IN";
  const supplyType: SupplyType = !isIndian ? "export" : context.buyerTaxId ? "b2b" : "b2c";
  const buyerStateCode = isIndian ? context.buyerStateCode ?? null : null;
  const base = {
    cgst: 0,
    sgst: 0,
    igst: 0,
    supplyType,
    buyerStateCode,
    placeOfSupply: isIndian ? stateName(buyerStateCode) : null,
  };

  const rate = isIndian ? gstRatePercent() : 0;
  if (rate <= 0 || subtotal <= 0) {
    return { subtotal, taxAmount: 0, taxRate: 0, taxLabel: null, total: subtotal, ...base };
  }

  // Work in whole paise so rounding is exact and the invoice adds up to the charged amount.
  const subtotalMinor = toMinorUnits(subtotal, currency);
  let cgstMinor = 0;
  let sgstMinor = 0;
  let igstMinor = 0;
  if (isSameState(buyerStateCode, context.sellerStateCode)) {
    // CGST and SGST are equal by law, so each half is rounded on its own.
    cgstMinor = Math.round((subtotalMinor * rate) / 200);
    sgstMinor = cgstMinor;
  } else {
    igstMinor = Math.round((subtotalMinor * rate) / 100);
  }
  const taxMinor = cgstMinor + sgstMinor + igstMinor;

  return {
    subtotal,
    taxAmount: taxMinor / 100,
    taxRate: rate,
    taxLabel: "GST",
    total: (subtotalMinor + taxMinor) / 100,
    ...base,
    cgst: cgstMinor / 100,
    sgst: sgstMinor / 100,
    igst: igstMinor / 100,
  };
}
