import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
import { logger } from "../../utils/logger";
import { AuthTokenPayload } from "../auth/auth.service";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

/** The only events a webchat visitor's socket may receive (see broadcastLocally). */
const VISITOR_EVENTS: ReadonlySet<string> = new Set([
  "message:new",
  "conversation:message",
  "message:status",
  "conversation:typing",
  "conversation:agent",
]);
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export interface RealtimeSocket extends WebSocket {
  isAlive: boolean;
  user?: AuthTokenPayload;
  tenantId?: string;
  userId?: string;
  subscriptions: Set<string>;
  isPlatformUser?: boolean;
  isVisitor?: boolean;
  conversationId?: string;
  role?: string;
  email?: string;
}

export interface RealtimeMessageEvent {
  event: string;
  data: any;
  tenantId: string;
  targetUserId?: string;
  conversationId?: string;
  timestamp: string;
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Set<RealtimeSocket> = new Set();
  private redisPub: ReturnType<typeof createClient> | null = null;
  private redisSub: ReturnType<typeof createClient> | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private isRedisReady: boolean = false;

  public async init(server: HttpServer): Promise<void> {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    // Initialize Redis Pub/Sub for horizontal scaling across distributed nodes
    await this.initRedisPubSub();

    this.wss.on("connection", (ws: WebSocket, req) => {
      const socket = ws as RealtimeSocket;
      socket.isAlive = true;
      socket.subscriptions = new Set(["*"]); // default subscribe to all tenant events

      // Register error listener early to avoid unhandled socket exceptions
      socket.on("error", (err: any) => {
        if (err?.code === "ECONNABORTED" || err?.code === "ECONNRESET" || err?.code === "EPIPE") {
          // Benign socket disconnect from client navigation or browser reload
          this.clients.delete(socket);
          return;
        }
        logger.debug("WebSocket client socket error", { error: err.message });
        this.clients.delete(socket);
      });

      // Parse token from query parameter or Authorization header
      const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
      const token =
        url.searchParams.get("token") ||
        (req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.slice(7)
          : null);

      if (!token) {
        logger.debug("WebSocket connection rejected: No authentication token provided");
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "error", message: "Authentication required" }), () => {
              try { socket.close(1008, "Token required"); } catch {}
            });
          } else {
            socket.close(1008, "Token required");
          }
        } catch {
          try { socket.close(1008, "Token required"); } catch {}
        }
        return;
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        const uid = decoded.userId || decoded.id || decoded.platformUserId || decoded.contactId || decoded.visitorSessionId;
        const isPlatform = Boolean(decoded.isPlatformUser || decoded.platformUserId);
        const isVisitor = Boolean(decoded.isVisitor || decoded.role === "visitor");

        if (!isPlatform && (!decoded.tenantId || !uid)) {
          throw new Error("Invalid token claims");
        }

        socket.isPlatformUser = isPlatform;
        socket.isVisitor = isVisitor;

        if (isPlatform) {
          socket.userId = decoded.platformUserId || uid;
          socket.tenantId = "platform";
          socket.role = decoded.role || "super_admin";
          socket.email = decoded.email || "";
          socket.subscriptions = new Set(["*"]);
        } else if (isVisitor) {
          if (!decoded.tenantId || !decoded.conversationId) {
            throw new Error("Invalid visitor token claims: tenantId and conversationId required");
          }
          socket.userId = uid || "visitor";
          socket.tenantId = decoded.tenantId;
          socket.conversationId = decoded.conversationId;
          socket.role = "visitor";
          socket.subscriptions = new Set([`conversation:${decoded.conversationId}`]);
        } else {
          socket.user = {
            userId: uid,
            tenantId: decoded.tenantId,
            role: decoded.role || "agent",
            email: decoded.email || "",
          };
          socket.tenantId = decoded.tenantId;
          socket.userId = uid;
        }

        this.clients.add(socket);
        logger.info("WebSocket client connected", {
          tenantId: socket.tenantId,
          userId: socket.userId,
          role: socket.isPlatformUser ? socket.role : (socket.isVisitor ? "visitor" : socket.user?.role),
          isPlatformUser: socket.isPlatformUser,
          isVisitor: socket.isVisitor,
          conversationId: socket.conversationId,
        });

        // Send connection confirmation
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "connection_established",
              tenantId: socket.tenantId,
              userId: socket.userId,
              isPlatformUser: socket.isPlatformUser,
              isVisitor: Boolean(socket.isVisitor),
              conversationId: socket.conversationId,
              timestamp: new Date().toISOString(),
            })
          );
        }
      } catch (err: any) {
        logger.debug("WebSocket authentication failed", { error: err.message });
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }), () => {
              try { socket.close(1008, "Authentication failed"); } catch {}
            });
          } else {
            socket.close(1008, "Authentication failed");
          }
        } catch {
          try { socket.close(1008, "Authentication failed"); } catch {}
        }
        return;
      }

      // Heartbeat ping-pong
      socket.on("pong", () => {
        socket.isAlive = true;
      });

      // Handle client incoming messages (subscriptions / pings / typing)
      socket.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping" && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          } else if (msg.type === "subscribe" && msg.channel) {
            if (socket.isVisitor) {
              if (msg.channel === `conversation:${socket.conversationId}`) {
                socket.subscriptions.add(msg.channel);
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
                }
              }
            } else {
              socket.subscriptions.add(msg.channel);
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
              }
            }
          } else if (msg.type === "unsubscribe" && msg.channel) {
            if (!socket.isVisitor) {
              socket.subscriptions.delete(msg.channel);
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "unsubscribed", channel: msg.channel }));
              }
            }
          } else if (msg.type === "typing") {
            if (socket.isVisitor && socket.conversationId && socket.tenantId) {
              this.publish(
                socket.tenantId,
                "conversation:typing",
                {
                  conversationId: socket.conversationId,
                  isTyping: Boolean(msg.isTyping),
                  sender: "visitor",
                  userId: socket.userId,
                },
                { conversationId: socket.conversationId }
              ).catch(() => {});
            } else if (!socket.isVisitor && msg.conversationId && socket.tenantId) {
              this.publish(
                socket.tenantId,
                "conversation:typing",
                {
                  conversationId: msg.conversationId,
                  isTyping: Boolean(msg.isTyping),
                  sender: "agent",
                  userId: socket.userId,
                },
                { conversationId: msg.conversationId }
              ).catch(() => {});
            }
          }
        } catch {
          // ignore malformed client frames
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        logger.debug("WebSocket client disconnected", {
          tenantId: socket.tenantId,
          userId: socket.userId,
        });
      });
    });

    // Start periodic ping/pong connection sweeper (30s)
    this.pingInterval = setInterval(() => {
      this.clients.forEach((socket) => {
        if (!socket.isAlive) {
          logger.debug("Terminating inactive WebSocket client", {
            tenantId: socket.tenantId,
            userId: socket.userId,
          });
          try {
            socket.terminate();
          } catch {}
          this.clients.delete(socket);
          return;
        }
        socket.isAlive = false;
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping();
          }
        } catch {}
      });
    }, 30000);
  }

  private async initRedisPubSub(): Promise<void> {
    try {
      this.redisPub = createClient({ url: REDIS_URL });
      this.redisSub = createClient({ url: REDIS_URL });

      this.redisPub.on("error", (err) =>
        logger.warn("Redis Publisher error (non-fatal, falling back to local)", { error: err.message })
      );
      this.redisSub.on("error", (err) =>
        logger.warn("Redis Subscriber error (non-fatal, falling back to local)", { error: err.message })
      );

      await Promise.all([this.redisPub.connect(), this.redisSub.connect()]);
      this.isRedisReady = true;

      // Subscribe to all tenant & platform pub/sub channels
      await this.redisSub.pSubscribe("omni:tenant:*", (message, channel) => {
        try {
          const tenantId = channel.replace("omni:tenant:", "");
          const eventPayload: RealtimeMessageEvent = JSON.parse(message);
          this.broadcastLocally(tenantId, eventPayload);
        } catch (err: any) {
          logger.error("Error processing Redis tenant pub/sub event", { error: err.message });
        }
      });

      await this.redisSub.pSubscribe("omni:platform:*", (message) => {
        try {
          const eventPayload: RealtimeMessageEvent = JSON.parse(message);
          this.broadcastLocally("platform", eventPayload);
        } catch (err: any) {
          logger.error("Error processing Redis platform pub/sub event", { error: err.message });
        }
      });

      logger.info("Redis Pub/Sub Real-Time WebSocket cluster connected successfully");
    } catch (err: any) {
      this.isRedisReady = false;
      logger.warn("Redis Pub/Sub unavailable, falling back to in-memory WebSocket broadcast", {
        error: err.message,
      });
    }
  }

  /**
   * Broadcast an event to local connected WebSockets matching tenant and target filters
   */
  private broadcastLocally(tenantId: string, payload: RealtimeMessageEvent): void {
    const rawMessage = JSON.stringify({
      type: "event",
      event: payload.event,
      data: payload.data,
      timestamp: payload.timestamp,
    });

    this.clients.forEach((socket) => {
      if (socket.readyState !== WebSocket.OPEN) return;

      if (socket.isPlatformUser) {
        // Platform staff sockets receive platform-level broadcasts and cross-tenant support ticket events
        const isSupportEvent = payload.event.startsWith("support_ticket:");
        const isPlatformEvent = tenantId === "platform" || payload.tenantId === "platform" || payload.event.startsWith("platform:") || payload.event.startsWith("system:");

        if (!isSupportEvent && !isPlatformEvent) {
          return; // Zero-PII: Platform users never receive tenant customer chat messages or transcripts
        }

        try {
          socket.send(rawMessage);
        } catch {
          // Socket error
        }
        return;
      }

      // Guest Visitor socket filtering
      if (socket.isVisitor) {
        if (socket.tenantId !== tenantId) return;
        if (!payload.conversationId || payload.conversationId !== socket.conversationId) return;
        // Strict Zero-Internal-Note & Tenant Separation: Visitors only receive messages/typing for their conversation
        if (payload.event.startsWith("support_ticket:") || payload.event.startsWith("platform:") || payload.event.startsWith("system:")) return;
        if (payload.data?.isInternalNote || payload.data?.message?.isInternalNote) return;
        // Only chat content reaches a visitor. Events such as conversation:update carry the assignee's
        // identity, team, tenant and contact fields; the visitor learns about hand-offs through the
        // sanitized conversation:agent event instead.
        if (!VISITOR_EVENTS.has(payload.event)) return;

        try {
          socket.send(rawMessage);
        } catch (err) {
          // Socket closed or closing
        }
        return;
      }

      // Tenant socket filtering
      if (socket.tenantId !== tenantId) return;

      // Strict Zero-Internal-Note Privacy Rule: Internal notes are strictly for platform staff and never sent to tenant sockets
      if (payload.event.startsWith("support_ticket:") && (payload.data?.isInternalNote || payload.data?.message?.isInternalNote)) {
        return;
      }

      // Check user target filter if specified
      if (payload.targetUserId && socket.userId !== payload.targetUserId) {
        return;
      }

      // Check conversation subscription filter if specified
      if (
        payload.conversationId &&
        !socket.subscriptions.has("*") &&
        !socket.subscriptions.has(`conversation:${payload.conversationId}`)
      ) {
        return;
      }

      try {
        socket.send(rawMessage);
      } catch (err) {
        // Socket closed or closing mid-broadcast
      }
    });
  }

  /**
   * Publish a real-time event across the distributed cluster.
   */
  public async publish(
    tenantId: string,
    event: string,
    data: any,
    options?: { targetUserId?: string; conversationId?: string }
  ): Promise<void> {
    const payload: RealtimeMessageEvent = {
      event,
      data,
      tenantId,
      targetUserId: options?.targetUserId,
      conversationId: options?.conversationId,
      timestamp: new Date().toISOString(),
    };

    if (this.isRedisReady && this.redisPub) {
      try {
        const channel = tenantId === "platform" ? "omni:platform:events" : `omni:tenant:${tenantId}`;
        await this.redisPub.publish(channel, JSON.stringify(payload));

        // If this is a support ticket event, also publish to platform channel so cross-tenant staff nodes get it
        if (event.startsWith("support_ticket:") && tenantId !== "platform") {
          await this.redisPub.publish("omni:platform:support", JSON.stringify(payload));
        }
        return;
      } catch (err: any) {
        logger.warn("Redis publish failed, falling back to local broadcast", { error: err.message });
      }
    }

    // Direct local fallback
    this.broadcastLocally(tenantId, payload);
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public getStats(): { totalConnections: number; activeTenants: number; isRedisReady: boolean } {
    const activeTenants = new Set<string>();
    for (const client of this.clients) {
      if (client.tenantId) {
        activeTenants.add(client.tenantId);
      }
    }
    return {
      totalConnections: this.clients.size,
      activeTenants: activeTenants.size,
      isRedisReady: this.isRedisReady,
    };
  }

  public close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.redisPub) {
      this.redisPub.quit().catch(() => {});
    }
    if (this.redisSub) {
      this.redisSub.quit().catch(() => {});
    }
  }
}

export const realtimeGateway = new WebSocketManager();

/**
 * Convenient global helper to emit real-time events to all agents in a tenant
 */
export async function emitRealtimeEvent(
  tenantId: string,
  event: string,
  data: any,
  options?: { targetUserId?: string; conversationId?: string }
): Promise<void> {
  return realtimeGateway.publish(tenantId, event, data, options);
}
