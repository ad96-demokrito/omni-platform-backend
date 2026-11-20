import { isMetaUploadHandle, uploadHeaderSample } from "./meta-upload";

export interface TemplateButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE" | string;
  text?: string;
  url?: string;
  phone_number?: string;
  phoneNumber?: string;
  code?: string;
  example?: string | string[];
}

/** One card of a media-card carousel: HEADER (IMAGE/VIDEO) + optional BODY + BUTTONS. */
export interface TemplateCarouselCard {
  components: TemplateComponent[];
}

export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS" | "CAROUSEL";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  /** Object-storage key of the uploaded header sample; converted to a Meta upload handle on create. */
  mediaStorageKey?: string;
  text?: string;
  buttons?: TemplateButton[];
  /** Only for type "CAROUSEL". */
  cards?: TemplateCarouselCard[];
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

export interface CreateTemplateInput {
  name: string;
  language: string; // e.g. "en_US"
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  components: TemplateComponent[];
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string; // APPROVED | PENDING | REJECTED
  components: TemplateComponent[];
}

/**
 * Every call needs the tenant's own WABA id + access token (from their
 * channel credentials) — templates are submitted and approved per-WABA,
 * not globally. This is the Tech Provider difference: a Solution Partner
 * customer wouldn't call the Graph API directly for this at all.
 */
export async function listTemplates(
  wabaId: string,
  accessToken: string,
  apiBaseUrl: string
): Promise<WhatsAppTemplate[]> {
  const url = `${apiBaseUrl}/${wabaId}/message_templates?fields=name,status,category,language,components`;
  console.log(`[Templates] Fetching message templates from Meta WABA: ${wabaId}...`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Templates] Meta API returned ${response.status} for WABA ${wabaId}:`, errText);
    let errMsg = `Meta API error (${response.status})`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson?.error?.message) {
        errMsg = `Meta: ${errJson.error.message}`;
      }
    } catch {
      errMsg = `Failed to list templates (${response.status}): ${errText}`;
    }
    throw new Error(errMsg);
  }
  const data = (await response.json()) as { data?: WhatsAppTemplate[] };
  return data.data ?? [];
}

interface MetaUploadContext {
  accessToken: string;
  apiBaseUrl: string;
}

/** Maps our button form to Meta's button objects. Shared by the top-level BUTTONS and carousel cards. */
function buildMetaButtons(buttons: TemplateButton[]): Record<string, unknown>[] {
  return buttons.map((btn) => {
    const b: Record<string, unknown> = { type: btn.type };
    if (btn.type === "QUICK_REPLY") {
      b.text = btn.text;
    } else if (btn.type === "URL") {
      b.text = btn.text;
      b.url = btn.url;
      if (btn.example) {
        b.example = Array.isArray(btn.example) ? btn.example : [btn.example];
      }
    } else if (btn.type === "PHONE_NUMBER") {
      b.text = btn.text;
      b.phone_number = btn.phone_number || btn.phoneNumber;
    } else if (btn.type === "COPY_CODE") {
      b.example = btn.code || btn.example;
    } else {
      if (btn.text) b.text = btn.text;
      if (btn.url) b.url = btn.url;
      if (btn.phone_number || btn.phoneNumber) b.phone_number = btn.phone_number || btn.phoneNumber;
    }
    return b;
  });
}

/** Media header: Meta needs a resumable-upload handle for the sample, not a URL. */
async function buildMediaHeaderExample(
  comp: TemplateComponent,
  ctx: MetaUploadContext
): Promise<{ header_handle: string[] }> {
  const given = comp.example?.header_handle?.[0];
  const handle = isMetaUploadHandle(given)
    ? given!
    : await uploadHeaderSample({
        accessToken: ctx.accessToken,
        apiBaseUrl: ctx.apiBaseUrl,
        mediaStorageKey: comp.mediaStorageKey,
        source: given,
      });
  return { header_handle: [handle] };
}

/** Builds one carousel card (HEADER + optional BODY + BUTTONS) in Meta's shape. */
async function buildMetaCard(
  card: TemplateCarouselCard,
  ctx: MetaUploadContext
): Promise<{ components: Record<string, unknown>[] }> {
  const components: Record<string, unknown>[] = [];
  for (const comp of card.components) {
    if (comp.type === "HEADER") {
      components.push({
        type: "HEADER",
        format: comp.format,
        example: await buildMediaHeaderExample(comp, ctx),
      });
    } else if (comp.type === "BODY") {
      const body: Record<string, unknown> = { type: "BODY", text: comp.text };
      if (comp.example?.body_text?.length) {
        body.example = { body_text: comp.example.body_text };
      }
      components.push(body);
    } else if (comp.type === "BUTTONS" && Array.isArray(comp.buttons)) {
      components.push({ type: "BUTTONS", buttons: buildMetaButtons(comp.buttons) });
    }
  }
  return { components };
}

export async function createTemplate(
  wabaId: string,
  accessToken: string,
  apiBaseUrl: string,
  template: CreateTemplateInput
): Promise<{ id: string; status: string; category: string }> {
  const url = `${apiBaseUrl}/${wabaId}/message_templates`;
  console.log(`[Templates] Submitting message template "${template.name}" to Meta WABA: ${wabaId}...`);
  const uploadCtx: MetaUploadContext = { accessToken, apiBaseUrl };

  // Normalize components for Meta Cloud API
  const formattedComponents = await Promise.all((template.components || []).map(async (comp) => {
    const formatted: any = { type: comp.type };

    if (comp.type === "HEADER") {
      formatted.format = comp.format || "TEXT";
      if (formatted.format === "TEXT" && comp.text) {
        formatted.text = comp.text;
      }
      if (formatted.format !== "TEXT") {
        formatted.example = await buildMediaHeaderExample(comp, uploadCtx);
      } else if (comp.example?.header_text?.length) {
        formatted.example = { header_text: comp.example.header_text };
      }
    } else if (comp.type === "BODY") {
      formatted.text = comp.text;
      if (comp.example?.body_text?.length) {
        formatted.example = { body_text: comp.example.body_text };
      }
    } else if (comp.type === "FOOTER") {
      formatted.text = comp.text;
    } else if (comp.type === "BUTTONS" && Array.isArray(comp.buttons)) {
      formatted.buttons = buildMetaButtons(comp.buttons);
    } else if (comp.type === "CAROUSEL" && Array.isArray(comp.cards)) {
      // Sequential on purpose: each card header is a separate resumable upload to Meta.
      formatted.cards = [];
      for (const card of comp.cards) {
        formatted.cards.push(await buildMetaCard(card, uploadCtx));
      }
    }

    return formatted;
  }));

  const payload = {
    name: template.name,
    language: template.language,
    category: template.category,
    components: formattedComponents,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Templates] Meta template creation returned ${response.status}:`, errText);
    let errMsg = `Meta API error (${response.status})`;
    try {
      const errJson = JSON.parse(errText);
      const e = errJson?.error;
      if (e?.message) {
        const detail = [e.error_user_title, e.error_user_msg].filter(Boolean).join(" — ");
        errMsg = `Meta: ${e.message}${detail ? ` (${detail})` : ""}`;
      }
    } catch {
      errMsg = `Failed to create template (${response.status}): ${errText}`;
    }
    throw new Error(errMsg);
  }
  return response.json() as Promise<{ id: string; status: string; category: string }>;
}
