import { getAdapter } from "../channels/channel-registry";
import { getChannelWithCredentials, getChannelByIdUnscoped } from "../channels/channels.service";
import {
  getCampaign,
  getCampaignByIdUnscoped,
  setCampaignStatus,
  getRecipientsByStatus,
  getDueDripRecipients,
  markBroadcastSent,
  markRecipientFailed,
  advanceDripRecipient,
  completeDripRecipient,
  startDripCampaign,
  finalizeFinishedDripCampaigns,
  Campaign,
} from "./campaigns.service";
import {
  BroadcastDefinition,
  DripDefinition,
  FlowCampaignDefinition,
  interpolate,
  normalizeDripSteps,
} from "./campaigns.types";
import { findOrCreateOpenConversation } from "../conversations/conversations.service";
import { sendOutboundMessage } from "../messages/messages.service";
import { logger } from "../../utils/logger";
import { runFlowForConversation, FlowRunSkipReason } from "../flows/flow-engine-runner";
import { getFlow } from "../flows/flows.service";
import { resolveHeaderMediaUrl } from "../../db/object-storage";
import { syncRecipientWithMessageStatus } from "./campaign-delivery-sync";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dripLog = logger.child({ module: "drip-scheduler" });

/**
 * Marks a recipient as accepted by the provider and stores the provider message id. A delivery
 * receipt can beat this write (the webhook handler had no recipient to update yet), so afterwards
 * pull in whatever status the message has already received.
 */
async function recordAcceptedSend(recipientId: string, tenantId: string, providerMessageId?: string): Promise<void> {
  await markBroadcastSent(recipientId, providerMessageId);
  if (!providerMessageId) return;
  await syncRecipientWithMessageStatus(tenantId, providerMessageId).catch((err) => {
    console.error(`[campaign-sender] Could not sync early delivery status for ${providerMessageId}:`, err);
  });
}

const SEND_DELAY_MS = 250;

const SKIP_REASON_LABELS: Record<FlowRunSkipReason, string> = {
  locked: "another flow pass was already running for this conversation",
  handed_off: "conversation is handed off to a human agent",
  no_flow: "no flow is configured",
  flow_unpublished: "flow is missing or not published",
  nothing_sent: "the flow produced no message to send",
};

const describeSkipReason = (reason: FlowRunSkipReason) => SKIP_REASON_LABELS[reason] ?? reason;

/** Final campaign status once the send loop ends, based on per-recipient outcomes. */
function resolveFinalCampaignStatus(sent: number, failed: number): "completed" | "partially_failed" | "failed" {
  if (failed === 0) return "completed";
  return sent === 0 ? "failed" : "partially_failed";
}

/**
 * Sends a 'broadcast' or 'flow' campaign to every pending recipient, right now.
 * When a flow is configured, it instantiates the conversation and executes the
 * visual flow engine pass (templates, buttons, wait timers, retries) for each contact.
 */
export async function sendBroadcastNow(
  tenantId: string,
  campaignId: string
): Promise<{ sent: number; failed: number }> {
  const campaign = await getCampaign(tenantId, campaignId);
  if (!campaign) throw new Error("Campaign not found");
  if (campaign.type !== "broadcast" && campaign.type !== "flow") {
    throw new Error("Only broadcast and flow campaigns can be triggered via sendBroadcastNow");
  }

  const channel = await getChannelWithCredentials(tenantId, campaign.channel_id);
  if (!channel) throw new Error("Channel not found");

  const definition = campaign.definition as BroadcastDefinition & FlowCampaignDefinition;
  const flowId = campaign.type === "flow" ? definition.flowId : definition.flowId;

  if (flowId) {
    const flow = await getFlow(tenantId, flowId);
    if (!flow || flow.status !== "published") {
      throw new Error(`Flow ${flowId} is missing or not published. Please publish the flow before launching the campaign.`);
    }
  }

  await setCampaignStatus(campaignId, "sending");

  const recipients = await getRecipientsByStatus(campaignId, "pending");
  let sent = 0;
  let failed = 0;
  let aborted = true;

  try {
    for (const recipient of recipients) {
      try {
        const recipientVars = {
          name: recipient.name || "",
          phone: recipient.external_id || "",
          email: recipient.attributes?.email || "",
          ...(recipient.attributes || {}),
          contact: {
            name: recipient.name || "",
            external_id: recipient.external_id || "",
            phone: recipient.external_id || "",
            email: recipient.attributes?.email || "",
            tags: recipient.attributes?.tags || [],
            attributes: recipient.attributes || {},
            ...(recipient.attributes || {}),
          },
        };

        if (flowId) {
          // 1. Flow-driven campaign: instantiate or reopen conversation, then run flow engine
          const conversation = await findOrCreateOpenConversation({
            tenantId,
            contactId: recipient.contact_id,
            channelId: campaign.channel_id,
          });

          const outcome = await runFlowForConversation({
            tenantId,
            conversationId: conversation.id,
            defaultFlowId: flowId,
            campaign: { campaignId, recipientId: recipient.id },
          });

          if (outcome.status === "skipped") {
            // The flow engine sent nothing (locked, handed off, unpublished, ...): not a success.
            await markRecipientFailed(recipient.id, `Not sent: ${describeSkipReason(outcome.reason)}`);
            failed++;
          } else {
            await recordAcceptedSend(recipient.id, tenantId, outcome.providerMessageId);
            sent++;
          }
        } else if (definition.templateName) {
          // 2. WhatsApp Template broadcast with optional media header
          const adapter = getAdapter(channel.type);
          // An uploaded header is signed fresh from its storage key on every send; the URL saved at
          // upload time expires, so a campaign sent days later would otherwise carry a dead link.
          const resolvedHeaderValue = definition.mediaStorageKey
            ? await resolveHeaderMediaUrl(definition.mediaStorageKey, definition.headerValue)
            : definition.headerValue
            ? interpolate(definition.headerValue, recipientVars)
            : undefined;

          const interpolatedParams: Record<string, string> = {};
          if (definition.templateParams) {
            for (const [key, val] of Object.entries(definition.templateParams)) {
              interpolatedParams[key] = interpolate(val, recipientVars);
            }
          }

          const templateResult = await adapter.send(
            {
              toExternalContactId: recipient.external_id,
              type: "template",
              templateName: definition.templateName,
              templateLanguage: definition.templateLanguage || "en",
              templateParams: interpolatedParams,
              headerType: definition.headerType,
              headerValue: resolvedHeaderValue,
              filename: definition.filename,
            },
            channel.credentials || {}
          );
          await recordAcceptedSend(recipient.id, tenantId, templateResult.providerMessageId);
          sent++;
        } else {
          // 3. Standard text broadcast message
          const adapter = getAdapter(channel.type);
          const text = interpolate(definition.text || "", recipientVars);
          const textResult = await adapter.send(
            { toExternalContactId: recipient.external_id, type: "text", text },
            channel.credentials || {}
          );
          await recordAcceptedSend(recipient.id, tenantId, textResult.providerMessageId);
          sent++;
        }
      } catch (err) {
        console.error(`[campaign-sender] Failed sending to recipient ${recipient.id}:`, err);
        await markRecipientFailed(recipient.id, err instanceof Error ? err.message : String(err));
        failed++;
      }

      await sleep(SEND_DELAY_MS);
    }
    aborted = false;
  } finally {
    // Always leave the "sending" state, reflecting what actually happened. An aborted
    // loop left recipients unprocessed, so it can never count as fully completed.
    await setCampaignStatus(campaignId, resolveFinalCampaignStatus(sent, aborted ? failed + 1 : failed));
  }
  return { sent, failed };
}

/**
 * Called on a timer to process drip sequences.
 */
export async function processDueDripSteps(): Promise<{ processed: number; failed: number }> {
  const due = await getDueDripRecipients();
  let processed = 0;
  let failed = 0;

  for (const recipient of due) {
    try {
      const campaign = await getCampaignByIdUnscoped(recipient.campaign_id);
      if (!campaign) {
        await markRecipientFailed(recipient.id, "Campaign no longer exists");
        failed++;
        continue;
      }

      const channel = await getChannelByIdUnscoped(campaign.channel_id);
      if (!channel) {
        await markRecipientFailed(recipient.id, "Channel no longer exists");
        failed++;
        continue;
      }

      const definition = campaign.definition as DripDefinition;
      const step = definition.steps[recipient.current_step];
      if (!step) {
        await completeDripRecipient(recipient.id);
        continue;
      }

      const recipientVars = {
        name: recipient.name || "",
        phone: recipient.external_id || "",
        email: recipient.attributes?.email || "",
        ...(recipient.attributes || {}),
        contact: {
          name: recipient.name || "",
          external_id: recipient.external_id || "",
          phone: recipient.external_id || "",
          email: recipient.attributes?.email || "",
          tags: recipient.attributes?.tags || [],
          attributes: recipient.attributes || {},
          ...(recipient.attributes || {}),
        },
      };
      const text = interpolate(step.text, recipientVars);
      if (!text.trim()) {
        // Meta rejects an empty text.body; fail with a reason an operator can act on instead.
        throw new Error(`Drip step ${recipient.current_step + 1} has no message text`);
      }

      // Send through the conversation, not straight through the adapter, so the step is stored as an
      // outbound message: it then appears in the team inbox and picks up delivered/read receipts.
      const conversation = await findOrCreateOpenConversation({
        tenantId: campaign.tenant_id,
        contactId: recipient.contact_id,
        channelId: campaign.channel_id,
      });
      await sendOutboundMessage({
        tenantId: campaign.tenant_id,
        conversationId: conversation.id,
        text,
      });
      dripLog.info("drip step sent and stored in the inbox", {
        campaignId: campaign.id,
        step: recipient.current_step + 1,
        conversationId: conversation.id,
      });

      const nextStepIndex = recipient.current_step + 1;
      const nextStep = definition.steps[nextStepIndex];
      if (!nextStep) {
        await completeDripRecipient(recipient.id);
      } else {
        const nextSendAt = new Date(Date.now() + nextStep.delayHours * 60 * 60 * 1000);
        await advanceDripRecipient(recipient.id, nextStepIndex, nextSendAt);
      }

      processed++;
    } catch (err) {
      await markRecipientFailed(recipient.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  await finalizeFinishedDripCampaigns();

  return { processed, failed };
}

/**
 * Starts a draft drip campaign. Step 1 goes out after its own delay (immediately when 0); the
 * scheduler in index.ts sends the rest. Returns null when the campaign was already started.
 * Throws when the saved steps are invalid, so a broken campaign never starts.
 */
export async function startDrip(
  tenantId: string,
  campaign: Campaign
): Promise<{ scheduled: number } | null> {
  const normalized = normalizeDripSteps((campaign.definition as Partial<DripDefinition>).steps);
  if ("error" in normalized) throw new Error(normalized.error);

  const channel = await getChannelWithCredentials(tenantId, campaign.channel_id);
  if (!channel) throw new Error("Channel not found");

  return startDripCampaign({ tenantId, campaignId: campaign.id, steps: normalized.steps });
}
