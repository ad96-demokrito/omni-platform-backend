export interface BroadcastDefinition {
  text?: string; // supports {{name}} interpolation against the contact's name
  flowId?: string; // If set, this broadcast runs a Visual Flow for each recipient
  tags?: string[]; // Tag filter used to generate recipient list
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string;
  mediaStorageKey?: string;
  filename?: string;
}

export interface FlowCampaignDefinition {
  flowId: string; // Flow ID from the visual flow builder
  tags?: string[];
}

export interface DripStep {
  delayHours: number; // hours after the PREVIOUS step (0 for the first step = send immediately)
  text: string;
}

export interface DripDefinition {
  steps: DripStep[];
}

export const DRIP_MAX_STEPS = 50;
export const DRIP_MAX_DELAY_HOURS = 24 * 365;
export const DRIP_MAX_TEXT_LENGTH = 4096;

/**
 * Validates drip steps from an API payload or a stored definition and reduces them to the
 * canonical `{ delayHours, text }` shape. The create form used to send the text under `message`,
 * so that legacy key is accepted and mapped to `text`.
 */
export function normalizeDripSteps(rawSteps: unknown): { steps: DripStep[] } | { error: string } {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { error: "drip definition requires a non-empty steps array" };
  }
  if (rawSteps.length > DRIP_MAX_STEPS) {
    return { error: `drip definition allows at most ${DRIP_MAX_STEPS} steps` };
  }

  const steps: DripStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw: unknown = rawSteps[i];
    const stepNumber = i + 1;
    if (typeof raw !== "object" || raw === null) {
      return { error: `Drip step ${stepNumber} is invalid` };
    }
    const { text, message, delayHours } = raw as Record<string, unknown>;

    const body = typeof text === "string" ? text : typeof message === "string" ? message : "";
    if (!body.trim()) {
      return { error: `Drip step ${stepNumber} needs message text` };
    }
    if (body.length > DRIP_MAX_TEXT_LENGTH) {
      return { error: `Drip step ${stepNumber} text must be at most ${DRIP_MAX_TEXT_LENGTH} characters` };
    }

    const delay = delayHours === undefined ? 0 : Number(delayHours);
    if (!Number.isFinite(delay) || delay < 0 || delay > DRIP_MAX_DELAY_HOURS) {
      return {
        error: `Drip step ${stepNumber} delayHours must be a number between 0 and ${DRIP_MAX_DELAY_HOURS}`,
      };
    }

    steps.push({ delayHours: delay, text: body.trim() });
  }
  return { steps };
}

export function interpolate(template: string, vars: Record<string, any>): string {
  if (!template || typeof template !== "string") return "";
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path) => {
    const parts = path.split(".");
    let curr: any = vars;
    for (const part of parts) {
      if (curr === undefined || curr === null) return "";
      curr = curr[part];
    }
    return curr !== undefined && curr !== null ? String(curr) : "";
  });
}
