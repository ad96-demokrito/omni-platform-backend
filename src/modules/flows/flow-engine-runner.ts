import { queryOne } from "../../db/pool";
import { withLock } from "../../db/redis";
import { sendOutboundMessage } from "../messages/messages.service";
import {
  getActiveFlowRun,
  getLatestFlowRun,
  createFlowRun,
  attachFlowRunToCampaign,
  updateFlowRun,
  endFlowRun,
  getFlow,
} from "./flows.service";
import { advanceFlow, resumeFlowOnDeliveryStatus } from "./flow-engine";
import { scheduleDelayedFlowResume } from "../jobs/queue.service";
import { recordCampaignAnswers } from "../campaigns/campaign-answers";
import { markConversationNeedsHuman } from "../conversations/conversations.service";

export type FlowRunSkipReason = "locked" | "handed_off" | "no_flow" | "flow_unpublished" | "nothing_sent";

/**
 * What a flow pass actually did. `sent` means at least one message was accepted
 * by the channel provider; `skipped` means nothing went out (and why).
 */
export type FlowRunOutcome =
  | { status: "sent"; providerMessageId?: string }
  | { status: "skipped"; reason: FlowRunSkipReason };

/**
 * Called from the webhook handler after an inbound message is persisted,
 * or from a delayed queue worker waking up.
 */
export async function runFlowForConversation(params: {
  tenantId: string;
  conversationId: string;
  defaultFlowId: string | null;
  incomingText?: string;
  resumeAtNodeId?: string;
  /** Set by the campaign sender so the run's answers can be exported per recipient. */
  campaign?: { campaignId: string; recipientId: string };
}): Promise<FlowRunOutcome> {
  const { tenantId, conversationId, defaultFlowId, incomingText, resumeAtNodeId, campaign } = params;

  const result = await withLock<FlowRunOutcome>(`flow-lock:${conversationId}`, 10_000, async () => {
    let flowRun = await getActiveFlowRun(conversationId);

    // A campaign's flow always wins over a leftover run of another flow on the same conversation.
    if (flowRun && campaign && defaultFlowId && flowRun.flow_id !== defaultFlowId) {
      await endFlowRun(flowRun.id, "completed");
      flowRun = null;
    }

    if (!flowRun) {
      // Check if conversation was handed off to a human agent
      const latestRun = await getLatestFlowRun(conversationId);
      if (latestRun && latestRun.status === "handed_off") {
        console.log(`[flow-engine] conversation ${conversationId} is handed off to agent — skipping flow trigger`);
        return { status: "skipped", reason: "handed_off" };
      }

      if (!defaultFlowId) return { status: "skipped", reason: "no_flow" }; // no flow configured for this channel
      flowRun = await createFlowRun({
        conversationId,
        flowId: defaultFlowId,
        campaignId: campaign?.campaignId,
        campaignRecipientId: campaign?.recipientId,
      });
    } else if (campaign && !flowRun.campaign_id && flowRun.flow_id === defaultFlowId) {
      // The contact is already in this flow: attribute the run to the campaign without restarting it.
      await attachFlowRunToCampaign(flowRun.id, campaign.campaignId, campaign.recipientId);
      flowRun = { ...flowRun, campaign_id: campaign.campaignId, campaign_recipient_id: campaign.recipientId };
    }

    const flow = await getFlow(tenantId, flowRun.flow_id);
    if (!flow || flow.status !== "published") {
      console.warn(`[flow-engine] flow ${flowRun.flow_id} is missing or not published — skipping`);
      return { status: "skipped", reason: "flow_unpublished" };
    }

    // Hydrate contact details & custom attributes from PostgreSQL
    const contactRow = await queryOne<any>(
      `SELECT c.id, c.name, c.external_id, c.attributes
       FROM contacts c
       JOIN conversations conv ON conv.contact_id = c.id
       WHERE conv.id = $1`,
      [conversationId]
    );

    const contactAttributes = contactRow?.attributes || {};
    const contactScope = {
      id: contactRow?.id || "",
      name: contactRow?.name || "",
      external_id: contactRow?.external_id || "",
      phone: contactRow?.external_id || "",
      email: contactAttributes.email || "",
      tags: contactAttributes.tags || [],
      attributes: contactAttributes,
      ...contactAttributes,
    };

    const mergedVariables = {
      name: contactRow?.name || "",
      phone: contactRow?.external_id || "",
      email: contactAttributes.email || "",
      ...contactAttributes,
      contact: contactScope,
      ...(flowRun.variables || {}),
    };

    const advance = await advanceFlow(
      flow.definition,
      { currentNodeId: flowRun.current_node_id, variables: mergedVariables },
      incomingText,
      resumeAtNodeId,
      { tenantId, conversationId }
    );

    // Send messages and record providerMessageId
    let lastProviderMessageId: string | undefined;
    // The first message of the pass is the one a campaign recipient is tracked by
    let firstProviderMessageId: string | undefined;

    try {
      for (const msg of advance.outboundMessages) {
        if (msg.type === "text") {
          const sent = await sendOutboundMessage({ tenantId, conversationId, text: msg.text });
          lastProviderMessageId = sent.provider_message_id;
          firstProviderMessageId ??= sent.provider_message_id;
        } else if (msg.type === "template") {
          const sent = await sendOutboundMessage({
            tenantId,
            conversationId,
            type: "template",
            templateName: msg.templateName,
            templateLanguage: msg.templateLanguage,
            templateParams: msg.templateParams,
            headerType: msg.headerType,
            headerValue: msg.headerValue,
            mediaStorageKey: msg.mediaStorageKey,
            filename: msg.filename,
          });
          lastProviderMessageId = sent.provider_message_id;
          firstProviderMessageId ??= sent.provider_message_id;
        }
      }
    } catch (err) {
      // The send was rejected (e.g. 24h window closed, unreachable header media). Don't leave the run
      // "running" — a later campaign would resume this flow instead of starting its own.
      await endFlowRun(flowRun.id, "failed").catch((e) => {
        console.error(`[flow-engine] could not mark run ${flowRun!.id} failed:`, e);
      });
      throw err;
    }

    const updatedVariables = { ...advance.variables };
    if (lastProviderMessageId) {
      updatedVariables["_last_wamid"] = lastProviderMessageId;
    }

    // Schedule delayed job if wait/retry node was hit
    if (advance.scheduledResume) {
      await scheduleDelayedFlowResume(
        {
          tenantId,
          conversationId,
          flowRunId: flowRun.id,
          targetNodeId: advance.scheduledResume.targetNodeId,
        },
        advance.scheduledResume.delaySeconds
      );
    }

    await updateFlowRun(flowRun.id, {
      currentNodeId: advance.nextNodeId,
      variables: updatedVariables,
      status: advance.status === "awaiting_delivery" || advance.status === "waiting" ? "running" : advance.status,
    });

    if (advance.status === "handed_off") {
      // Bot -> human: show the case as "pending" so agents see it needs a person.
      await markConversationNeedsHuman(tenantId, conversationId).catch((err) => {
        console.error(`[flow-engine] could not mark conversation ${conversationId} as pending:`, err);
      });
    }

    if (flowRun.campaign_id && flowRun.campaign_recipient_id && advance.answers?.length) {
      // Best effort: a failed export record must never break the live conversation.
      await recordCampaignAnswers({
        tenantId,
        campaignId: flowRun.campaign_id,
        campaignRecipientId: flowRun.campaign_recipient_id,
        flowRunId: flowRun.id,
        answers: advance.answers,
      }).catch((err) => {
        console.error(`[flow-engine] could not record campaign answers for run ${flowRun.id}:`, err);
      });
    }

    // A flow that starts with a wait/delay node sends nothing yet but is running as designed.
    if (!firstProviderMessageId && !advance.scheduledResume) return { status: "skipped", reason: "nothing_sent" };
    return { status: "sent", providerMessageId: firstProviderMessageId };
  });

  if (result === "locked") {
    console.warn(`[flow-engine] conversation ${conversationId} is already being processed — skipped this pass`);
    return { status: "skipped", reason: "locked" };
  }
  return result;
}

/**
 * Called when a delivery receipt or failure status webhook arrives from WhatsApp.
 */
export async function handleDeliveryStatusCallback(params: {
  tenantId: string;
  conversationId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  const { tenantId, conversationId, status, errorCode, errorMessage } = params;

  if (status !== "delivered" && status !== "read" && status !== "failed") {
    return; // 'sent' status is an ack, does not advance delivery-wait nodes
  }

  const result = await withLock(`flow-lock:${conversationId}`, 10_000, async () => {
    const flowRun = await getActiveFlowRun(conversationId);
    if (!flowRun || !flowRun.current_node_id) return;

    const flow = await getFlow(tenantId, flowRun.flow_id);
    if (!flow || flow.status !== "published") return;

    const normalizedStatus = status === "read" ? "delivered" : status;

    const advance = await resumeFlowOnDeliveryStatus(
      flow.definition,
      { currentNodeId: flowRun.current_node_id, variables: flowRun.variables },
      normalizedStatus,
      { code: errorCode, message: errorMessage }
    );

    // The flow's own message failed and the node has no failure path: end the run, otherwise it
    // stays "running" and the next campaign to this contact resumes it instead of its own flow.
    if (
      status === "failed" &&
      flowRun.variables?._last_wamid === params.providerMessageId &&
      advance.outboundMessages.length === 0 &&
      advance.nextNodeId === flowRun.current_node_id
    ) {
      console.warn(`[flow-engine] message failed (${errorCode ?? "unknown"}) — ending flow run ${flowRun.id}`);
      await endFlowRun(flowRun.id, "failed");
      return;
    }

    // Send any subsequent messages along the chosen path
    for (const msg of advance.outboundMessages) {
      if (msg.type === "text") {
        await sendOutboundMessage({ tenantId, conversationId, text: msg.text });
      } else if (msg.type === "template") {
        await sendOutboundMessage({
          tenantId,
          conversationId,
          type: "template",
          templateName: msg.templateName,
          templateLanguage: msg.templateLanguage,
          templateParams: msg.templateParams,
          headerType: msg.headerType,
          headerValue: msg.headerValue,
          mediaStorageKey: msg.mediaStorageKey,
          filename: msg.filename,
        });
      }
    }

    if (advance.scheduledResume) {
      await scheduleDelayedFlowResume(
        {
          tenantId,
          conversationId,
          flowRunId: flowRun.id,
          targetNodeId: advance.scheduledResume.targetNodeId,
        },
        advance.scheduledResume.delaySeconds
      );
    }

    await updateFlowRun(flowRun.id, {
      currentNodeId: advance.nextNodeId,
      variables: advance.variables,
      status: advance.status === "awaiting_delivery" || advance.status === "waiting" ? "running" : advance.status,
    });
  });

  if (result === "locked") {
    console.warn(`[flow-engine] conversation ${conversationId} is locked during status update`);
  }
}
