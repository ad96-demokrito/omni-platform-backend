import { redis, ensureRedisConnected } from "../../db/redis";
import { emitRealtimeEvent } from "../realtime/websocket.service";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "agent-typing" });

/** The inbox re-sends "typing" every few seconds while an agent types; the flag lapses on its own. */
const AGENT_TYPING_TTL_SECONDS = 6;

const typingKey = (tenantId: string, conversationId: string): string =>
  `typing:agent:${tenantId}:${conversationId}`;

/**
 * Records that an agent is (or stopped) typing and tells the conversation's live sockets. Webchat
 * visitors on the polling script read the flag via `isAgentTyping`. Typing is cosmetic, so failures
 * are logged and swallowed.
 */
export async function setAgentTyping(tenantId: string, conversationId: string, isTyping: boolean): Promise<void> {
  try {
    await ensureRedisConnected();
    if (isTyping) {
      await redis.set(typingKey(tenantId, conversationId), "1", { EX: AGENT_TYPING_TTL_SECONDS });
    } else {
      await redis.del(typingKey(tenantId, conversationId));
    }
    await emitRealtimeEvent(
      tenantId,
      "conversation:typing",
      { conversationId, isTyping, sender: "agent" },
      { conversationId }
    );
  } catch (err) {
    log.warn("Could not record agent typing", { error: (err as Error).message });
  }
}

export async function isAgentTyping(tenantId: string, conversationId: string): Promise<boolean> {
  try {
    await ensureRedisConnected();
    return (await redis.get(typingKey(tenantId, conversationId))) === "1";
  } catch {
    return false;
  }
}
