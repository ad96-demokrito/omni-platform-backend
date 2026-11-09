import {
  FlowDefinition,
  FlowNode,
  WaitNode,
  AIAgentNode,
  IntentRouterNode,
  HandoffAssignMode,
  HandoffPriority,
} from "./flows.types";
import { RAGService } from "../ai/rag.service";
import { CopilotService } from "../ai/copilot.service";

export interface OutboundFlowMessage {
  type: "text" | "template";
  text?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string;
  mediaStorageKey?: string;
  filename?: string;
  nodeId?: string;
  waitForDelivery?: boolean;
}

export interface ScheduledResume {
  delaySeconds: number;
  targetNodeId: string;
}

/** A question the contact answered during this pass (input node or template button). */
export interface FlowAnswer {
  nodeId: string;
  question: string;
  answer: string;
}

/** What a hand-off node asked for, with its text already interpolated. Set when `status` is "handed_off". */
export interface HandoffRequest {
  nodeId: string;
  teamId?: string;
  agentUserId?: string;
  assignMode: HandoffAssignMode;
  reason?: string;
  priority: HandoffPriority;
  /** 0 = never resume the bot automatically. */
  timeoutMinutes: number;
  timeoutMessage?: string;
}

export interface AdvanceResult {
  nextNodeId: string | null;
  variables: Record<string, any>;
  status: "running" | "waiting" | "awaiting_delivery" | "completed" | "handed_off";
  /** Messages to send out, in order, as this pass through the graph executes. */
  outboundMessages: OutboundFlowMessage[];
  handoff?: HandoffRequest;
  scheduledResume?: ScheduledResume;
  /** Questions answered during this pass, in order. Set by `advanceFlow`. */
  answers?: FlowAnswer[];
}

function getNode(def: FlowDefinition, id: string): FlowNode | undefined {
  return def.nodes.find((n) => n.id === id);
}

/**
 * Variable interpolation with support for nested object paths (e.g. {{ contact.name }})
 * and whitespace tolerance.
 */
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

function convertDurationToSeconds(duration: number, unit?: string): number {
  switch (unit) {
    case "minutes":
      return duration * 60;
    case "hours":
      return duration * 3600;
    case "days":
      return duration * 86400;
    case "seconds":
    default:
      return duration;
  }
}

/**
 * Checks if a node is actively configured to await delivery status receipts.
 */
function isDeliveryWaitingNode(node: FlowNode): boolean {
  if (node.type === "message" || node.type === "template") {
    return Boolean(
      node.waitForDelivery ||
      node.onDelivered ||
      node.onFailed ||
      node.ports?.some((p) => p.id === "delivered" || p.id === "failed")
    );
  }
  return false;
}

/**
 * Resolves the next node pointer from ports, status hooks, or default next.
 */
function resolvePortNext(node: FlowNode, portId: "continue" | "delivered" | "failed" | string): string | null {
  if (portId === "delivered") {
    if ((node as any).onDelivered) return (node as any).onDelivered;
    const foundPort = (node as any).ports?.find((p: any) => p.id === "delivered");
    if (foundPort?.next) return foundPort.next;
    return (node as any).next ?? null;
  }
  if (portId === "failed") {
    if ((node as any).onFailed) return (node as any).onFailed;
    const foundPort = (node as any).ports?.find((p: any) => p.id === "failed");
    if (foundPort?.next) return foundPort.next;
    return null; // Do not fallback to success next on failure
  }
  const foundPort = (node as any).ports?.find((p: any) => p.id === portId);
  if (foundPort?.next) {
    return foundPort.next;
  }
  return (node as any).next ?? null;
}

/**
 * Pure state machine engine. Advances execution until an async pause
 * (input node, delivery confirmation wait, wait timer, or completion).
 */
export async function advanceFlow(
  def: FlowDefinition,
  state: { currentNodeId: string | null; variables: Record<string, any> },
  incomingText?: string,
  resumeAtNodeId?: string,
  context?: { tenantId?: string; conversationId?: string }
): Promise<AdvanceResult> {
  // Collected as a side channel so the many early returns below stay untouched.
  const answers: FlowAnswer[] = [];
  const result = await runFlowSteps(def, state, answers, incomingText, resumeAtNodeId, context);
  return { ...result, answers };
}

async function runFlowSteps(
  def: FlowDefinition,
  state: { currentNodeId: string | null; variables: Record<string, any> },
  answers: FlowAnswer[],
  incomingText?: string,
  resumeAtNodeId?: string,
  context?: { tenantId?: string; conversationId?: string }
): Promise<AdvanceResult> {
  let nodeId: string | null = resumeAtNodeId ?? state.currentNodeId ?? def.entryNodeId;
  const variables = { ...state.variables };
  if (incomingText !== undefined) {
    variables["last_message"] = incomingText;
  }
  const outboundMessages: OutboundFlowMessage[] = [];
  let pendingReply = incomingText;

  for (let steps = 0; steps < 100; steps++) {
    if (!nodeId) return { nextNodeId: null, variables, status: "completed", outboundMessages };

    const node = getNode(def, nodeId);
    if (!node) return { nextNodeId: null, variables, status: "completed", outboundMessages };

    switch (node.type) {
      case "message": {
        const interpolatedText = interpolate(node.text, variables);
        const shouldWaitForDelivery = isDeliveryWaitingNode(node);

        outboundMessages.push({
          type: "text",
          text: interpolatedText,
          nodeId: node.id,
          waitForDelivery: shouldWaitForDelivery,
        });

        if (shouldWaitForDelivery) {
          // Pause execution on this message node, waiting for WhatsApp status webhook callback
          return {
            nextNodeId: node.id,
            variables,
            status: "awaiting_delivery",
            outboundMessages,
          };
        }

        nodeId = resolvePortNext(node, "continue");
        continue;
      }

      case "input": {
        const alreadyWaitingHere = state.currentNodeId === node.id;
        if (alreadyWaitingHere && pendingReply !== undefined) {
          variables[node.saveAs] = pendingReply;
          answers.push({
            nodeId: node.id,
            question: interpolate(node.prompt, variables),
            answer: pendingReply,
          });
          pendingReply = undefined;
          nodeId = resolvePortNext(node, "continue");
          continue;
        }
        // First time reaching this node this pass — ask, then pause here.
        const interpolatedPrompt = interpolate(node.prompt, variables);
        outboundMessages.push({ type: "text", text: interpolatedPrompt, nodeId: node.id });
        return { nextNodeId: node.id, variables, status: "running", outboundMessages };
      }

      case "template": {
        const alreadyWaitingHere = state.currentNodeId === node.id;
        if (alreadyWaitingHere && pendingReply !== undefined) {
          if (node.saveAs) {
            variables[node.saveAs] = pendingReply;
          }
          if (node.saveAs || (node.buttons && node.buttons.length > 0)) {
            answers.push({
              nodeId: node.id,
              question: node.templateName,
              answer: pendingReply,
            });
          }

          // Match incoming reply against configured button actions (case-insensitive trim)
          const replyClean = pendingReply.trim().toLowerCase();
          const matchedButton = node.buttons?.find(
            (btn) => btn.buttonText.trim().toLowerCase() === replyClean
          );

          if (matchedButton) {
            nodeId = matchedButton.next;
          } else {
            nodeId = resolvePortNext(node, "continue");
          }

          pendingReply = undefined;
          continue;
        }

        // First time reaching this template node:
        const interpolatedParams: Record<string, string> = {};
        if (node.templateParams) {
          for (const [key, val] of Object.entries(node.templateParams)) {
            interpolatedParams[key] = interpolate(val, variables);
          }
        }

        const interpolatedHeaderValue = node.headerValue ? interpolate(node.headerValue, variables) : undefined;
        const shouldWaitForDelivery = isDeliveryWaitingNode(node);

        outboundMessages.push({
          type: "template",
          templateName: node.templateName,
          templateLanguage: node.language || "en",
          templateParams: interpolatedParams,
          headerType: node.headerType,
          headerValue: interpolatedHeaderValue,
          mediaStorageKey: node.mediaStorageKey,
          filename: node.filename,
          nodeId: node.id,
          waitForDelivery: shouldWaitForDelivery,
        });

        // If template has buttons, pause and wait for the user's interactive tap
        if (node.buttons && node.buttons.length > 0) {
          return { nextNodeId: node.id, variables, status: "running", outboundMessages };
        }

        if (shouldWaitForDelivery) {
          return {
            nextNodeId: node.id,
            variables,
            status: "awaiting_delivery",
            outboundMessages,
          };
        }

        // If no buttons and not waiting on delivery receipt, progress immediately
        nodeId = resolvePortNext(node, "continue");
        continue;
      }

      case "wait": {
        const durationSec = convertDurationToSeconds(node.duration, node.durationUnit);
        const targetNext = node.next || node.ports?.find((p) => p.id === "continue")?.next;

        if (!targetNext) {
          return { nextNodeId: null, variables, status: "completed", outboundMessages };
        }

        return {
          nextNodeId: node.id,
          variables,
          status: "waiting",
          outboundMessages,
          scheduledResume: {
            delaySeconds: durationSec,
            targetNodeId: targetNext,
          },
        };
      }

      case "condition": {
        const rawValue = variables[node.variable];
        const strVal = rawValue !== undefined && rawValue !== null ? String(rawValue).trim().toLowerCase() : "";
        const branch = node.branches?.find((b) => {
          const bVal = String(b.equals).trim().toLowerCase();
          return bVal === strVal || b.equals === String(rawValue);
        });
        nodeId = branch?.next ?? node.default ?? null;
        continue;
      }

      case "action": {
        if (node.action === "webhook" && node.url) {
          const interpolatedUrl = interpolate(node.url, variables);
          try {
            console.log(`[flow-engine] webhook action dispatched: ${interpolatedUrl}`);
            const response = await fetch(interpolatedUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ variables }),
              signal: AbortSignal.timeout(5000),
            });
            if (response.ok) {
              try {
                const data = await response.json();
                if (data && typeof data === "object") {
                  Object.assign(variables, data);
                }
              } catch {
                // non-JSON responses are ignored
              }
              nodeId = node.onSuccess || resolvePortNext(node, "continue");
            } else {
              nodeId = node.onFailure || resolvePortNext(node, "continue");
            }
          } catch (err) {
            console.warn(`[flow-engine] webhook action request failed:`, err);
            nodeId = node.onFailure || resolvePortNext(node, "continue");
          }
        } else {
          nodeId = resolvePortNext(node, "continue");
        }
        continue;
      }

      case "ai_agent": {
        const queryVar = (node as AIAgentNode).queryVariable;
        const userQuery = queryVar
          ? String(variables[queryVar] ?? "")
          : String(incomingText ?? variables["last_message"] ?? variables["query"] ?? "");
        const kbId = (node as AIAgentNode).knowledgeBaseId;

        if (context?.tenantId && kbId && userQuery.trim()) {
          try {
            const interpolatedQuery = interpolate(userQuery, variables);
            const customPrompt = (node as AIAgentNode).prompt
              ? interpolate((node as AIAgentNode).prompt!, variables)
              : undefined;

            const ragResult = await RAGService.queryKnowledgeBase({
              tenantId: context.tenantId,
              knowledgeBaseId: kbId,
              query: interpolatedQuery,
              conversationId: context.conversationId,
              customSystemPrompt: customPrompt,
            });

            const saveKey = (node as AIAgentNode).saveResponseAs || "ai_response";
            variables[saveKey] = ragResult.answer;
            variables[`${saveKey}_confidence`] = ragResult.confidence;

            if ((node as AIAgentNode).sendImmediately !== false && ragResult.answer) {
              outboundMessages.push({
                type: "text",
                text: ragResult.answer,
                nodeId: node.id,
              });
            }

            const threshold = (node as AIAgentNode).fallbackThreshold ?? 0.2;
            if (ragResult.confidence < threshold && (node as AIAgentNode).onFallback) {
              nodeId = (node as AIAgentNode).onFallback!;
            } else {
              nodeId = resolvePortNext(node, "continue");
            }
          } catch (err) {
            console.error(`[flow-engine] AI Agent node ${node.id} execution failed:`, err);
            nodeId = (node as AIAgentNode).onFallback || resolvePortNext(node, "continue");
          }
        } else {
          nodeId = (node as AIAgentNode).onFallback || resolvePortNext(node, "continue");
        }
        continue;
      }

      case "intent_router": {
        const inputVar = (node as IntentRouterNode).inputVariable;
        const textToClassify = inputVar
          ? String(variables[inputVar] ?? "")
          : String(incomingText ?? variables["last_message"] ?? "");

        if (context?.tenantId && textToClassify.trim()) {
          try {
            const interpolatedText = interpolate(textToClassify, variables);
            const classification = await CopilotService.classifyIntentAndSentiment(
              context.tenantId,
              interpolatedText
            );

            const saveIntentKey = (node as IntentRouterNode).saveIntentAs || "detected_intent";
            const saveSentimentKey = (node as IntentRouterNode).saveSentimentAs || "detected_sentiment";
            variables[saveIntentKey] = classification.intent;
            variables[saveSentimentKey] = classification.sentiment;
            variables[`${saveIntentKey}_confidence`] = classification.confidence;

            const branches = (node as IntentRouterNode).branches || [];
            const matchedBranch = branches.find(
              (b) => b.intent.toLowerCase() === classification.intent.toLowerCase()
            );

            nodeId = matchedBranch?.next ?? (node as IntentRouterNode).default ?? resolvePortNext(node, "continue");
          } catch (err) {
            console.error(`[flow-engine] Intent Router node ${node.id} execution failed:`, err);
            nodeId = (node as IntentRouterNode).default ?? resolvePortNext(node, "continue");
          }
        } else {
          nodeId = (node as IntentRouterNode).default ?? resolvePortNext(node, "continue");
        }
        continue;
      }

      case "handoff": {
        // The customer is told what happens next; without this message they hear nothing until an agent writes.
        const customerMessage = node.customerMessage ? interpolate(node.customerMessage, variables).trim() : "";
        if (customerMessage) {
          outboundMessages.push({ type: "text", text: customerMessage, nodeId: node.id });
        }
        return {
          nextNodeId: null,
          variables,
          status: "handed_off",
          outboundMessages,
          handoff: {
            nodeId: node.id,
            teamId: node.teamId || undefined,
            agentUserId: node.agentUserId || undefined,
            assignMode: node.assignMode ?? "default",
            reason: node.reason ? interpolate(node.reason, variables).trim() || undefined : undefined,
            priority: node.priority ?? "normal",
            timeoutMinutes: node.timeoutMinutes && node.timeoutMinutes > 0 ? node.timeoutMinutes : 0,
            timeoutMessage: node.timeoutMessage
              ? interpolate(node.timeoutMessage, variables).trim() || undefined
              : undefined,
          },
        };
      }

      case "end": {
        return { nextNodeId: null, variables, status: "completed", outboundMessages };
      }
    }
  }

  console.warn("[flow-engine] step limit reached — possible cycle in flow definition");
  return { nextNodeId: null, variables, status: "completed", outboundMessages };
}

/**
 * Resumes execution when a WhatsApp delivery status receipt arrives.
 */
export async function resumeFlowOnDeliveryStatus(
  def: FlowDefinition,
  state: { currentNodeId: string | null; variables: Record<string, any> },
  deliveryStatus: "delivered" | "read" | "failed",
  errorDetails?: { code?: string; message?: string }
): Promise<AdvanceResult> {
  if (!state.currentNodeId) {
    return { nextNodeId: null, variables: state.variables, status: "completed", outboundMessages: [] };
  }

  const node = getNode(def, state.currentNodeId);
  if (!node) {
    return { nextNodeId: null, variables: state.variables, status: "completed", outboundMessages: [] };
  }

  // Guard: If the current node is not waiting for delivery (e.g. paused at input node),
  // do not let delivery callbacks advance or interrupt the waiting state.
  if (!isDeliveryWaitingNode(node)) {
    return { nextNodeId: state.currentNodeId, variables: state.variables, status: "running", outboundMessages: [] };
  }

  const variables = { ...state.variables };
  let nextNodeId: string | null = null;

  if (deliveryStatus === "delivered" || deliveryStatus === "read") {
    variables["_last_delivery_status"] = "delivered";
    nextNodeId = resolvePortNext(node, "delivered");
  } else if (deliveryStatus === "failed") {
    variables["_last_delivery_status"] = "failed";
    if (errorDetails) {
      variables["_last_error_code"] = errorDetails.code || "UNKNOWN";
      variables["_last_error_message"] = errorDetails.message || "Ecosystem error";
    }

    // Check node retry configuration
    const retryConfig = (node as any).retryConfig;
    if (retryConfig?.maxRetries && retryConfig.maxRetries > 0) {
      const retryKey = `_retries_${node.id}`;
      const currentRetries = Number(variables[retryKey] || 0);

      if (currentRetries < retryConfig.maxRetries) {
        variables[retryKey] = currentRetries + 1;
        const retryDelay = retryConfig.delaySeconds || 60;

        // Schedule auto-retry back to the same node
        return {
          nextNodeId: node.id,
          variables,
          status: "waiting",
          outboundMessages: [],
          scheduledResume: {
            delaySeconds: retryDelay,
            targetNodeId: node.id,
          },
        };
      }
    }

    nextNodeId = resolvePortNext(node, "failed");
  }

  if (!nextNodeId) {
    return { nextNodeId: null, variables, status: "completed", outboundMessages: [] };
  }

  // Continue advancing through the target branch
  return advanceFlow(def, { currentNodeId: null, variables }, undefined, nextNodeId);
}
