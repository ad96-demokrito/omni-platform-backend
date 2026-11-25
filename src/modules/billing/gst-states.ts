/**
 * Indian GST state / union-territory codes (the first two digits of a GSTIN). The place of supply of a service is
 * the customer's state: the same state as the seller means CGST + SGST, any other state means IGST.
 */
export interface GstState {
  code: string;
  name: string;
}

export const GST_STATES: ReadonlyArray<GstState> = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

const NAME_BY_CODE = new Map(GST_STATES.map((state) => [state.code, state.name]));

/** The two-digit code when `value` is a real GST state code, otherwise null. */
export function normalizeStateCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return NAME_BY_CODE.has(code) ? code : null;
}

export function stateName(code: string | null | undefined): string | null {
  return code ? NAME_BY_CODE.get(code.trim()) ?? null : null;
}

/** The state code a GSTIN starts with (null when it is not a valid state code). */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  return gstin ? normalizeStateCode(gstin.trim().slice(0, 2)) : null;
}
