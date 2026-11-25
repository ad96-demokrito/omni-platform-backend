import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { requireFeature } from "../billing/plan-limits.service";
import { asyncHandler } from "../../middleware/async-handler";
import { CopilotService } from "./copilot.service";
import { RAGService } from "./rag.service";
import { query } from "../../db/pool";

export const aiRouter = Router();
aiRouter.use(requireAuth);
aiRouter.use(requireFeature("ai_copilot"));

// POST /api/ai/copilot/suggest - Get smart reply suggestions for conversation
aiRouter.post(
  "/copilot/suggest",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { conversationId, customContext } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    const suggestions = await CopilotService.suggestReplies(
      tenantId,
      conversationId,
      customContext
    );

    res.json(suggestions);
  })
);

// POST /api/ai/copilot/summarize - Summarize conversation thread
aiRouter.post(
  "/copilot/summarize",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { conversationId } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    const summary = await CopilotService.summarizeConversation(
      tenantId,
      conversationId
    );

    res.json(summary);
  })
);

// POST /api/ai/copilot/rephrase - Rephrase / tone shift / translate draft message
aiRouter.post(
  "/copilot/rephrase",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { text, tone, targetLanguage } = req.body;

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const result = await CopilotService.rephraseMessage(
      tenantId,
      text,
      tone || "professional",
      targetLanguage
    );

    res.json(result);
  })
);

// POST /api/ai/classify - Intent & sentiment classification
aiRouter.post(
  "/classify",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { text } = req.body;

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const result = await CopilotService.classifyIntentAndSentiment(tenantId, text);
    res.json(result);
  })
);

// POST /api/ai/rag/query - Direct RAG query against Knowledge Base
aiRouter.post(
  "/rag/query",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const {
      knowledgeBaseId,
      query: queryText,
      conversationId,
      topK,
      threshold,
      customSystemPrompt,
      history,
    } = req.body;

    if (!knowledgeBaseId) {
      return res.status(400).json({ error: "knowledgeBaseId is required" });
    }
    if (!queryText || typeof queryText !== "string" || !queryText.trim()) {
      return res.status(400).json({ error: "query is required" });
    }

    const result = await RAGService.queryKnowledgeBase({
      tenantId,
      knowledgeBaseId,
      query: queryText,
      conversationId,
      topK,
      threshold,
      customSystemPrompt,
      history,
    });

    res.json(result);
  })
);

// GET /api/ai/logs - List recent AI telemetry logs
aiRouter.get(
  "/logs",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { limit = 50, feature } = req.query;

    let sql = `SELECT * FROM ai_logs WHERE tenant_id = $1`;
    const params: any[] = [tenantId];

    if (feature && typeof feature === "string") {
      sql += ` AND feature = $2`;
      params.push(feature);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(String(limit), 10) || 50);

    const logs = await query(sql, params);
    res.json({ logs });
  })
);
