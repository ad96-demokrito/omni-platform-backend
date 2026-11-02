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

export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  /** Object-storage key of the uploaded header sample; converted to a Meta upload handle on create. */
  mediaStorageKey?: string;
  text?: string;
  buttons?: TemplateButton[];
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

export async function createTemplate(
  wabaId: string,
  accessToken: string,
  apiBaseUrl: string,
  template: CreateTemplateInput
): Promise<{ id: string; status: string; category: string }> {
  const url = `${apiBaseUrl}/${wabaId}/message_templates`;
  console.log(`[Templates] Submitting message template "${template.name}" to Meta WABA: ${wabaId}...`);

  // Normalize components for Meta Cloud API
  const formattedComponents = await Promise.all((template.components || []).map(async (comp) => {
    const formatted: any = { type: comp.type };

    if (comp.type === "HEADER") {
      formatted.format = comp.format || "TEXT";
      if (formatted.format === "TEXT" && comp.text) {
        formatted.text = comp.text;
      }
      if (formatted.format !== "TEXT") {
        // Media header: Meta needs an upload handle, not a URL.
        const given = comp.example?.header_handle?.[0];
        const handle = isMetaUploadHandle(given)
          ? given!
          : await uploadHeaderSample({
              accessToken,
              apiBaseUrl,
              mediaStorageKey: comp.mediaStorageKey,
              source: given,
            });
        formatted.example = { header_handle: [handle] };
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
      formatted.buttons = comp.buttons.map((btn) => {
        const b: any = { type: btn.type };
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
