import { query, queryOne } from "../../db/pool";
import { KnowledgeBase, KnowledgeChunk, RAGQueryParams, RAGQueryResult } from "./ai.types";
import { generateEmbedding, cosineSimilarity } from "./embeddings.service";
import { AIProvider, ChatMessage } from "./ai.provider";
import { logger } from "../../utils/logger";
import { assertAiAllowed } from "../billing/plan-limits.service";

const log = logger.child({ module: "rag-service" });

export class RAGService {
  /**
   * Executes a Retrieval-Augmented Generation (RAG) query against a specific Knowledge Base.
   */
  public static async queryKnowledgeBase(params: RAGQueryParams): Promise<RAGQueryResult> {
    await assertAiAllowed(params.tenantId);
    const startTime = Date.now();

    // 1. Fetch Knowledge Base
    const kb = await queryOne<KnowledgeBase>(
      `SELECT * FROM knowledge_bases WHERE id = $1 AND tenant_id = $2`,
      [params.knowledgeBaseId, params.tenantId]
    );

    if (!kb) {
      throw new Error(`Knowledge base ${params.knowledgeBaseId} not found`);
    }

    if (!kb.is_active) {
      throw new Error(`Knowledge base "${kb.name}" is currently inactive`);
    }

    // 2. Generate embedding for user query
    const queryEmbedding = await generateEmbedding(params.query);

    // 3. Fetch all chunks in this Knowledge Base
    const rawChunks = await query<{
      id: string;
      document_id: string;
      chunk_index: number;
      content: string;
      token_count: number;
      embedding: string | number[] | null;
      document_title: string;
    }>(
      `SELECT kc.id, kc.document_id, kc.chunk_index, kc.content, kc.token_count, kc.embedding, kd.title as document_title
       FROM knowledge_chunks kc
       JOIN knowledge_documents kd ON kc.document_id = kd.id
       WHERE kc.tenant_id = $1 AND kc.knowledge_base_id = $2`,
      [params.tenantId, params.knowledgeBaseId]
    );

    // 4. Score chunks via Cosine Similarity
    const threshold = params.threshold ?? 0.25;
    const scoredChunks: Array<{
      id: string;
      documentId: string;
      documentTitle: string;
      content: string;
      score: number;
    }> = [];

    for (const chunk of rawChunks) {
      let chunkEmbedding: number[] | null = null;
      if (Array.isArray(chunk.embedding)) {
        chunkEmbedding = chunk.embedding;
      } else if (typeof chunk.embedding === "string") {
        try {
          chunkEmbedding = JSON.parse(chunk.embedding);
        } catch {
          chunkEmbedding = null;
        }
      }

      if (chunkEmbedding && chunkEmbedding.length > 0) {
        const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
        if (score >= threshold) {
          scoredChunks.push({
            id: chunk.id,
            documentId: chunk.document_id,
            documentTitle: chunk.document_title,
            content: chunk.content,
            score,
          });
        }
      }
    }

    // Sort descending by similarity score
    scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = scoredChunks.slice(0, params.topK || 4);

    // If no relevant chunks found in knowledge base
    if (topChunks.length === 0) {
      const fallbackMsg = "I could not find specific information regarding your request in our knowledge base. Would you like me to connect you with a team specialist?";

      // Log telemetry
      await query(
        `INSERT INTO ai_logs (tenant_id, conversation_id, knowledge_base_id, feature, prompt, response, latency_ms, tokens_used, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          params.tenantId,
          params.conversationId || null,
          params.knowledgeBaseId,
          "rag_query",
          params.query,
          fallbackMsg,
          Date.now() - startTime,
          10,
          kb.model,
        ]
      ).catch((err) => log.warn("Failed to record AI log", { error: err.message }));

      return {
        answer: fallbackMsg,
        confidence: 0.1,
        sources: [],
        model: kb.model,
        provider: kb.provider,
        latencyMs: Date.now() - startTime,
        tokensUsed: 10,
      };
    }

    // 5. Construct Grounding Context
    const contextText = topChunks
      .map((c, i) => `[Source ${i + 1}: ${c.documentTitle}]\n${c.content}`)
      .join("\n\n");

    const systemPrompt =
      params.customSystemPrompt ||
      kb.system_prompt ||
      "You are a helpful customer service AI assistant. Ground your answer solely on the provided context information. If the answer cannot be determined from the context, state that you do not have enough information and offer human assistance.";

    const fullSystemInstruction = `${systemPrompt}\n\n=== GROUNDING CONTEXT ===\n${contextText}\n========================\nAnswer the user's question directly, clearly, and politely based strictly on the context above. Include references to relevant sections if appropriate.`;

    const messages: ChatMessage[] = [
      { role: "system", content: fullSystemInstruction },
    ];

    if (params.history && params.history.length > 0) {
      for (const h of params.history.slice(-4)) {
        messages.push({ role: h.role, content: h.content });
      }
    }

    messages.push({ role: "user", content: params.query });

    // 6. Complete via AI Provider
    const completion = await AIProvider.complete(messages, {
      provider: kb.provider,
      model: kb.model,
      temperature: Number(kb.temperature) || 0.2,
      systemPrompt: fullSystemInstruction,
    });

    const sources = topChunks.map((c) => ({
      documentId: c.documentId,
      documentTitle: c.documentTitle,
      chunkId: c.id,
      snippet: c.content.slice(0, 200) + (c.content.length > 200 ? "..." : ""),
      similarityScore: Math.round(c.score * 1000) / 1000,
    }));

    const avgConfidence = topChunks.reduce((acc, cur) => acc + cur.score, 0) / topChunks.length;

    // 7. Record AI Telemetry Log
    await query(
      `INSERT INTO ai_logs (tenant_id, conversation_id, knowledge_base_id, feature, prompt, response, retrieved_chunks, latency_ms, tokens_used, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        params.tenantId,
        params.conversationId || null,
        params.knowledgeBaseId,
        "rag_query",
        params.query,
        completion.text,
        JSON.stringify(sources),
        completion.latencyMs,
        completion.tokensUsed,
        completion.model,
      ]
    ).catch((err) => log.warn("Failed to record AI log", { error: err.message }));

    return {
      answer: completion.text,
      confidence: Math.round(avgConfidence * 100) / 100,
      sources,
      model: completion.model,
      provider: completion.provider,
      latencyMs: completion.latencyMs,
      tokensUsed: completion.tokensUsed,
    };
  }
}
