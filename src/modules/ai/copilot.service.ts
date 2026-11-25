import { query } from "../../db/pool";
import { listMessages } from "../messages/messages.service";
import {
  CopilotSuggestResult,
  CopilotSummarizeResult,
  CopilotRephraseResult,
  CopilotTone,
  IntentClassificationResult,
} from "./ai.types";
import { AIProvider, ChatMessage } from "./ai.provider";
import { logger } from "../../utils/logger";
import { assertAiAllowed } from "../billing/plan-limits.service";

const log = logger.child({ module: "copilot-service" });

export class CopilotService {
  /**
   * Generates 3 contextual smart-reply suggestions for live agents in the Unified Inbox.
   */
  public static async suggestReplies(
    tenantId: string,
    conversationId: string,
    customContext?: string
  ): Promise<CopilotSuggestResult> {
    await assertAiAllowed(tenantId);
    const startTime = Date.now();

    // 1. Fetch recent messages
    const messagesList = await listMessages(tenantId, conversationId);
    const recentMessages = messagesList.slice(-6);
    const formattedHistory = recentMessages
      .map((m) => {
        const sender = m.direction === "inbound" ? "Customer" : "Agent";
        const content = m.text || (m.content ? JSON.stringify(m.content) : "[Media]");
        return `${sender}: ${content}`;
      })
      .join("\n");

    const systemPrompt = `You are an AI Support Copilot assisting live agents.
Based on the conversation history and context, generate 3 smart, distinct, and helpful reply suggestions for the agent to send.
- Suggestion 1: Direct Answer / Solution / Confirmation
- Suggestion 2: Clarification / Further Assistance
- Suggestion 3: Polite Follow-up or Action Step

Output MUST be a JSON object with this exact structure:
{
  "suggestions": [
    {
      "title": "Short 2-4 word summary",
      "text": "Full proposed message text ready to be sent to the customer",
      "category": "resolution" | "greeting" | "clarification" | "closing" | "commerce",
      "confidence": 0.95
    }
  ],
  "contextSummary": "One sentence summary of the current issue"
}`;

    const userPrompt = `Conversation History:\n${formattedHistory || "Customer: Hello, I have a question about my account."}\n\n${
      customContext ? `Additional Context: ${customContext}` : ""
    }\n\nGenerate 3 smart reply suggestions.`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    try {
      const completion = await AIProvider.complete(messages, {
        temperature: 0.3,
        jsonMode: true,
        systemPrompt,
      });

      let parsed: any;
      try {
        parsed = JSON.parse(completion.text);
      } catch {
        const jsonMatch = completion.text.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      }

      const result: CopilotSuggestResult = {
        suggestions: parsed?.suggestions && Array.isArray(parsed.suggestions)
          ? parsed.suggestions
          : [
              {
                title: "Acknowledge Query",
                text: "Thank you for getting in touch! We are looking into this for you right now.",
                category: "greeting",
                confidence: 0.9,
              },
              {
                title: "Provide Assistance",
                text: "I'd be happy to help with that. Could you please provide a few more details?",
                category: "clarification",
                confidence: 0.85,
              },
              {
                title: "Next Steps",
                text: "We have updated your record. Please let us know if there is anything else you need!",
                category: "resolution",
                confidence: 0.88,
              },
            ],
        contextSummary: parsed?.contextSummary || "Customer conversation active",
      };

      // Telemetry log
      await query(
        `INSERT INTO ai_logs (tenant_id, conversation_id, feature, prompt, response, latency_ms, tokens_used, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          conversationId,
          "copilot_suggest",
          userPrompt,
          JSON.stringify(result),
          Date.now() - startTime,
          completion.tokensUsed,
          completion.model,
        ]
      ).catch((err) => log.warn("Failed to record AI log", { error: err.message }));

      return result;
    } catch (err: any) {
      log.error("Failed to generate copilot reply suggestions", err);
      return {
        suggestions: [
          {
            title: "Quick Acknowledge",
            text: "Thank you for reaching out! Let me check this for you right away.",
            category: "greeting",
            confidence: 0.9,
          },
          {
            title: "Request Details",
            text: "Could you please share your order number or reference ID?",
            category: "clarification",
            confidence: 0.85,
          },
        ],
        contextSummary: "Active support conversation",
      };
    }
  }

  /**
   * Summarizes a conversation thread for quick agent handoff, CRM logs, and supervisor reviews.
   */
  public static async summarizeConversation(
    tenantId: string,
    conversationId: string
  ): Promise<CopilotSummarizeResult> {
    await assertAiAllowed(tenantId);
    const startTime = Date.now();

    // 1. Fetch conversation history
    const messagesList = await listMessages(tenantId, conversationId);
    const recentMessages = messagesList.slice(-20);

    const formattedHistory = recentMessages
      .map((m) => {
        const sender = m.direction === "inbound" ? "Customer" : "Agent";
        const content = m.text || (m.content ? JSON.stringify(m.content) : "[Media]");
        return `${sender}: ${content}`;
      })
      .join("\n");

    const systemPrompt = `You are an AI Support Analyst. Summarize the following customer conversation for internal agent handoff.
Output MUST be a JSON object with this exact structure:
{
  "summary": "Concise 2-3 sentence overview of the conversation and current status",
  "keyPoints": ["Bullet 1", "Bullet 2", "Bullet 3"],
  "sentiment": "positive" | "neutral" | "negative" | "urgent",
  "intent": "sales_inquiry" | "support_issue" | "order_status" | "complaint" | "general_faq",
  "suggestedAction": "Recommended next action for the agent",
  "language": "English"
}`;

    const userPrompt = `Conversation:\n${formattedHistory || "Customer: Hello, I have an inquiry about my recent order."}\n\nGenerate structured summary.`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    try {
      const completion = await AIProvider.complete(messages, {
        temperature: 0.2,
        jsonMode: true,
        systemPrompt,
      });

      let parsed: any;
      try {
        parsed = JSON.parse(completion.text);
      } catch {
        const jsonMatch = completion.text.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      }

      const result: CopilotSummarizeResult = {
        summary: parsed?.summary || "Customer reached out with a query regarding their account. Agent engaged and provided guidance.",
        keyPoints: parsed?.keyPoints || [
          "Customer initiated contact",
          "Discussed requirements",
          "Pending confirmation from customer"
        ],
        sentiment: parsed?.sentiment || "neutral",
        intent: parsed?.intent || "general_faq",
        suggestedAction: parsed?.suggestedAction || "Follow up if customer does not reply within 24 hours",
        language: parsed?.language || "English",
      };

      // Telemetry log
      await query(
        `INSERT INTO ai_logs (tenant_id, conversation_id, feature, prompt, response, latency_ms, tokens_used, model, sentiment, intent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tenantId,
          conversationId,
          "copilot_summarize",
          userPrompt,
          JSON.stringify(result),
          Date.now() - startTime,
          completion.tokensUsed,
          completion.model,
          result.sentiment,
          result.intent,
        ]
      ).catch((err) => log.warn("Failed to record AI log", { error: err.message }));

      return result;
    } catch (err: any) {
      log.error("Failed to summarize conversation", err);
      return {
        summary: "Customer reached out to support. Agent provided initial responses.",
        keyPoints: ["Inquiry received", "Agent replied with details"],
        sentiment: "neutral",
        intent: "general_faq",
        suggestedAction: "Monitor for customer response",
        language: "English",
      };
    }
  }

  /**
   * Rephrases or translates a draft message into a specific tone or language.
   */
  public static async rephraseMessage(
    tenantId: string,
    text: string,
    tone: CopilotTone = "professional",
    targetLanguage?: string
  ): Promise<CopilotRephraseResult> {
    await assertAiAllowed(tenantId);
    const startTime = Date.now();

    let instruction = "";
    switch (tone) {
      case "professional":
        instruction = "Rewrite this message in a polite, highly professional, corporate customer support tone.";
        break;
      case "friendly":
        instruction = "Rewrite this message in a warm, welcoming, empathetic, and friendly conversational tone.";
        break;
      case "concise":
        instruction = "Make this message as concise, direct, and clear as possible without losing any vital information.";
        break;
      case "bullet_points":
        instruction = "Format this message clearly into clean, well-structured bullet points.";
        break;
      case "translate":
        instruction = `Translate this message accurately and naturally into ${targetLanguage || "Spanish"}, maintaining a professional support tone.`;
        break;
      default:
        instruction = "Improve the clarity and politeness of this customer message.";
    }

    const systemPrompt = `You are an AI Text Editor for customer service agents. ${instruction}\nReturn ONLY the rephrased message text without quotes, conversational preambles, or markdown commentary.`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    const completion = await AIProvider.complete(messages, {
      temperature: 0.3,
      systemPrompt,
    });

    const cleanRephrased = completion.text.trim().replace(/^["']|["']$/g, "");

    // Telemetry log
    await query(
      `INSERT INTO ai_logs (tenant_id, feature, prompt, response, latency_ms, tokens_used, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        "copilot_rephrase",
        `[Tone: ${tone}] ${text}`,
        cleanRephrased,
        Date.now() - startTime,
        completion.tokensUsed,
        completion.model,
      ]
    ).catch((err) => log.warn("Failed to record AI log", { error: err.message }));

    return {
      original: text,
      rephrased: cleanRephrased,
      tone,
      targetLanguage,
    };
  }

  /**
   * Classifies message intent, sentiment, urgency, and extracts key entities.
   */
  public static async classifyIntentAndSentiment(
    tenantId: string,
    text: string
  ): Promise<IntentClassificationResult> {
    await assertAiAllowed(tenantId);
    const startTime = Date.now();

    const systemPrompt = `You are an AI Intent Classifier for customer conversations.
Classify the following customer message into one of these intents:
- 'sales_inquiry' (pricing, quotes, product features, buying)
- 'support_issue' (bugs, troubleshooting, broken features, how-to)
- 'order_status' (tracking, shipping, delivery updates, invoice)
- 'complaint' (refund requests, angry feedback, cancellations)
- 'general_faq' (hours, location, general info)

Determine:
- sentiment: 'positive' | 'neutral' | 'negative' | 'urgent'
- urgencyScore: number between 0.0 and 1.0
- confidence: number between 0.0 and 1.0
- entities: extracted key-value pairs (e.g. orderId, productName, email, phone)

Output MUST be a JSON object with this exact structure:
{
  "intent": "sales_inquiry" | "support_issue" | "order_status" | "complaint" | "general_faq",
  "confidence": 0.95,
  "sentiment": "positive" | "neutral" | "negative" | "urgent",
  "urgencyScore": 0.3,
  "entities": {}
}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    try {
      const completion = await AIProvider.complete(messages, {
        temperature: 0.1,
        jsonMode: true,
        systemPrompt,
      });

      let parsed: any;
      try {
        parsed = JSON.parse(completion.text);
      } catch {
        const jsonMatch = completion.text.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      }

      const result: IntentClassificationResult = {
        intent: parsed?.intent || "general_faq",
        confidence: parsed?.confidence || 0.85,
        sentiment: parsed?.sentiment || "neutral",
        urgencyScore: parsed?.urgencyScore || 0.2,
        entities: parsed?.entities || {},
      };

      // Telemetry log
      await query(
        `INSERT INTO ai_logs (tenant_id, feature, prompt, response, latency_ms, tokens_used, model, sentiment, intent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          "intent_classification",
          text,
          JSON.stringify(result),
          Date.now() - startTime,
          completion.tokensUsed,
          completion.model,
          result.sentiment,
          result.intent,
        ]
      ).catch((err) => log.warn("Failed to record AI log", { error: err.message }));

      return result;
    } catch (err: any) {
      log.error("Failed to classify intent & sentiment", err);
      return {
        intent: "general_faq",
        confidence: 0.7,
        sentiment: "neutral",
        urgencyScore: 0.2,
        entities: {},
      };
    }
  }
}
