/**
 * Flow Builder Type Definitions & AST Specification
 * Supports visual graph nodes, multi-port routing (Continue, Delivered, Failed),
 * asynchronous delivery receipts, Wait/Delay timers, and retry loops.
 */

import { isUuid } from "../../utils/http-error";

export interface TemplateButtonAction {
  buttonText: string;
  next: string;
}

export interface NodePort {
  id: string; // "continue" | "delivered" | "failed" | "button_0" etc.
  label?: string;
  next?: string;
}

export interface RetryConfig {
  maxRetries?: number;
  delaySeconds?: number;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle?: string; // e.g. "delivered", "failed", "continue", "btn-0"
  target: string;
  targetHandle?: string;
  label?: string;
}

export type MessageNode = {
  id: string;
  type: "message";
  text: string;
  waitForDelivery?: boolean; // If true, state machine pauses until delivery status webhook arrives
  onDelivered?: string; // Target node ID when WhatsApp returns 'delivered' or 'read'
  onFailed?: string; // Target node ID when WhatsApp returns 'failed' or ecosystem error
  retryConfig?: RetryConfig;
  next?: string; // Default continue next
  ports?: NodePort[];
  position?: NodePosition;
};

export type InputNode = {
  id: string;
  type: "input";
  prompt: string;
  saveAs: string; // variable name the reply gets stored under
  next?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type ConditionNode = {
  id: string;
  type: "condition";
  variable: string;
  branches: { equals: string; next: string }[];
  default?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type ActionNode = {
  id: string;
  type: "action";
  action: "webhook";
  url: string;
  next?: string;
  onSuccess?: string;
  onFailure?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type TemplateNode = {
  id: string;
  type: "template";
  templateName: string;
  language?: string; // e.g. "en", "en_US" (defaults to "en")
  templateParams?: Record<string, string>; // e.g. { "1": "{{userName}}", "2": "Order #123" }
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string; // static URL or {{variable}} or text
  mediaStorageKey?: string; // S3/MinIO key for uploaded template media asset
  filename?: string;
  buttons?: TemplateButtonAction[];
  waitForDelivery?: boolean;
  onDelivered?: string;
  onFailed?: string;
  retryConfig?: RetryConfig;
  saveAs?: string; // optional variable name to store button tap
  next?: string; // default fallback if no button matched or no buttons
  ports?: NodePort[];
  position?: NodePosition;
};

export type WaitNode = {
  id: string;
  type: "wait";
  duration: number; // e.g. 3600
  durationUnit?: "seconds" | "minutes" | "hours" | "days";
  next?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type AIAgentNode = {
  id: string;
  type: "ai_agent";
  knowledgeBaseId?: string;
  queryVariable?: string; // variable containing user query (default: last incoming reply or 'query')
  prompt?: string; // custom system prompt override
  saveResponseAs?: string; // variable to store AI answer (default: 'ai_response')
  sendImmediately?: boolean; // default true (automatically emit answer as outbound message)
  fallbackThreshold?: number; // default 0.2
  onFallback?: string; // target node if confidence is below threshold or error occurs
  next?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type IntentRouterNode = {
  id: string;
  type: "intent_router";
  inputVariable?: string; // variable containing user input (default: last incoming reply)
  branches: { intent: string; next: string }[];
  default?: string;
  saveIntentAs?: string;
  saveSentimentAs?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export const HANDOFF_PRIORITIES = ["normal", "high", "urgent"] as const;
export type HandoffPriority = (typeof HANDOFF_PRIORITIES)[number];

/** `default` follows the workspace auto-assign switch; the others override it for this node. */
export const HANDOFF_ASSIGN_MODES = ["default", "auto", "none"] as const;
export type HandoffAssignMode = (typeof HANDOFF_ASSIGN_MODES)[number];

export const HANDOFF_LIMITS = {
  customerMessage: 1000,
  reason: 200,
  timeoutMessage: 1000,
  maxTimeoutMinutes: 1440,
} as const;

export type HandoffNode = {
  id: string;
  type: "handoff";
  /** Support team the case is routed to (also the pool for auto-assign). */
  teamId?: string;
  /** A specific agent; always wins over auto-assign. */
  agentUserId?: string;
  assignMode?: HandoffAssignMode;
  /** Sent to the customer at hand-off; supports {{variables}}. */
  customerMessage?: string;
  /** Shown to agents in the inbox. */
  reason?: string;
  priority?: HandoffPriority;
  /** Resume the bot if nobody has taken the case after this many minutes (0/undefined = never). */
  timeoutMinutes?: number;
  /** Sent to the customer when the timeout resumes the bot. */
  timeoutMessage?: string;
  ports?: NodePort[];
  position?: NodePosition;
};

export type EndNode = {
  id: string;
  type: "end";
  ports?: NodePort[];
  position?: NodePosition;
};

export type FlowNode =
  | MessageNode
  | InputNode
  | ConditionNode
  | ActionNode
  | TemplateNode
  | WaitNode
  | AIAgentNode
  | IntentRouterNode
  | HandoffNode
  | EndNode;

export type FlowNodeType = FlowNode["type"];

export interface FlowDefinition {
  entryNodeId: string;
  nodes: FlowNode[];
  edges?: FlowEdge[];
}

/** Checks the optional hand-off settings; a node with none of them is valid (old behaviour). */
function validateHandoffNode(node: HandoffNode, errors: string[]): void {
  const label = `Node "${node.id}" (handoff)`;
  const optionalText = (value: unknown, field: string, max: number): void => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string" || value.length > max) {
      errors.push(`${label} ${field} must be text of at most ${max} characters`);
    }
  };
  const optionalUuid = (value: unknown, field: string): void => {
    if (value === undefined || value === null || value === "") return;
    if (!isUuid(value)) errors.push(`${label} ${field} is not a valid id`);
  };

  optionalUuid(node.teamId, "teamId");
  optionalUuid(node.agentUserId, "agentUserId");
  optionalText(node.customerMessage, "customerMessage", HANDOFF_LIMITS.customerMessage);
  optionalText(node.reason, "reason", HANDOFF_LIMITS.reason);
  optionalText(node.timeoutMessage, "timeoutMessage", HANDOFF_LIMITS.timeoutMessage);

  if (node.assignMode !== undefined && !(HANDOFF_ASSIGN_MODES as readonly string[]).includes(node.assignMode)) {
    errors.push(`${label} assignMode must be one of: ${HANDOFF_ASSIGN_MODES.join(", ")}`);
  }
  if (node.priority !== undefined && !(HANDOFF_PRIORITIES as readonly string[]).includes(node.priority)) {
    errors.push(`${label} priority must be one of: ${HANDOFF_PRIORITIES.join(", ")}`);
  }
  if (node.timeoutMinutes !== undefined) {
    const minutes = node.timeoutMinutes;
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < 0 ||
      minutes > HANDOFF_LIMITS.maxTimeoutMinutes
    ) {
      errors.push(`${label} timeoutMinutes must be a whole number from 0 to ${HANDOFF_LIMITS.maxTimeoutMinutes}`);
    }
  }
}

export function validateFlowDefinition(
  def: FlowDefinition,
  options?: { isPublishing?: boolean }
): string[] {
  const errors: string[] = [];

  if (!def || typeof def !== "object") {
    return ["Flow definition must be a valid object"];
  }

  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    return ["Flow definition must contain at least one node"];
  }

  const ids = new Set(def.nodes.map((n) => n?.id).filter(Boolean));

  if (!def.entryNodeId) {
    errors.push("entryNodeId is required");
  } else if (!ids.has(def.entryNodeId)) {
    errors.push(`entryNodeId "${def.entryNodeId}" is not a node in this flow`);
  }

  for (const node of def.nodes) {
    if (!node || typeof node !== "object" || !node.id) {
      errors.push("Flow contains an invalid node without an id");
      continue;
    }

    const checkNext = (next?: string) => {
      if (next && !ids.has(next)) errors.push(`Node "${node.id}" points to unknown node "${next}"`);
    };

    switch (node.type) {
      case "message":
        if (!node.text) errors.push(`Node "${node.id}" (message) is missing text`);
        checkNext(node.next);
        checkNext(node.onDelivered);
        checkNext(node.onFailed);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "input":
        if (!node.prompt) errors.push(`Node "${node.id}" (input) is missing prompt`);
        if (!node.saveAs) errors.push(`Node "${node.id}" (input) is missing saveAs`);
        checkNext(node.next);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "condition":
        if (!node.variable) errors.push(`Node "${node.id}" (condition) is missing variable`);
        if (!node.branches?.length && !node.default) errors.push(`Node "${node.id}" (condition) has no branches or default`);
        node.branches?.forEach((b) => checkNext(b.next));
        checkNext(node.default);
        break;
      case "action":
        if (!node.url) errors.push(`Node "${node.id}" (action) is missing url`);
        checkNext(node.next);
        checkNext(node.onSuccess);
        checkNext(node.onFailure);
        break;
      case "template":
        if (!node.templateName) errors.push(`Node "${node.id}" (template) is missing templateName`);
        if (node.buttons && Array.isArray(node.buttons)) {
          node.buttons.forEach((btn, idx) => {
            if (!btn.buttonText) errors.push(`Node "${node.id}" (template) button ${idx} is missing buttonText`);
            checkNext(btn.next);
          });
        }
        checkNext(node.next);
        checkNext(node.onDelivered);
        checkNext(node.onFailed);
        break;
      case "wait":
        if (typeof node.duration !== "number" || node.duration < 0) {
          errors.push(`Node "${node.id}" (wait) must have a valid non-negative duration`);
        }
        checkNext(node.next);
        break;
      case "ai_agent":
        if (options?.isPublishing && !node.knowledgeBaseId) {
          errors.push(`Node "${node.id}" (ai_agent) requires a selected Knowledge Base before publishing`);
        }
        checkNext(node.next);
        checkNext(node.onFallback);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "intent_router":
        if (!node.branches?.length && !node.default) {
          errors.push(`Node "${node.id}" (intent_router) has no branches or default`);
        }
        node.branches?.forEach((b) => checkNext(b.next));
        checkNext(node.default);
        node.ports?.forEach((p) => checkNext(p.next));
        break;
      case "handoff":
        validateHandoffNode(node, errors);
        break;
      case "end":
        break;
      default:
        errors.push(`Node "${(node as any).id}" has an unknown type "${(node as any).type}"`);
        break;
    }
  }

  return errors;
}
