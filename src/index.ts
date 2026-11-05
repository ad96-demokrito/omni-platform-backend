import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";

import { logger } from "./utils/logger";
import { requestLogger } from "./middleware/request-logger";
import { errorHandler } from "./middleware/error-handler";

import { authRouter } from "./modules/auth/auth.routes";
import { channelsRouter } from "./modules/channels/channels.routes";
import { contactsRouter } from "./modules/contacts/contacts.routes";
import { conversationsRouter } from "./modules/conversations/conversations.routes";
import { webhooksRouter } from "./modules/webhooks/webhooks.routes";
import { outgoingWebhooksRouter } from "./modules/webhooks/outgoing-webhooks.routes";
import { flowsRouter } from "./modules/flows/flows.routes";
import { dealsRouter } from "./modules/deals/deals.routes";
import { campaignsRouter } from "./modules/campaigns/campaigns.routes";
import { linksRouter } from "./modules/links/links.routes";
import { processDueDripSteps } from "./modules/campaigns/campaign-sender";
import {
  initDripSchedulerStatus,
  recordDripRunSuccess,
  recordDripRunError,
} from "./modules/campaigns/drip-scheduler-status";
import { whatsappOnboardingRouter } from "./modules/whatsapp-onboarding/embedded-signup.routes";
import { templatesRouter } from "./modules/whatsapp-onboarding/templates.routes";
import { searchRouter } from "./modules/search/search.routes";
import { mediaRouter } from "./modules/media/media.routes";
import { systemRouter } from "./modules/system/system.routes";
import { productsRouter } from "./modules/commerce/products.routes";
import { ordersRouter } from "./modules/commerce/orders.routes";
import { paymentsRouter, paymentWebhooksRouter } from "./modules/commerce/payments.routes";
import { knowledgeBaseRouter } from "./modules/ai/knowledge-base.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { apiKeysRouter } from "./modules/api-keys/api-keys.routes";
import { teamRouter } from "./modules/team/team.routes";
import { teamsRouter } from "./modules/teams/teams.routes";
import { billingRouter } from "./modules/billing/billing.routes";
import { complianceRouter } from "./modules/compliance/compliance.routes";
import { analyticsRouter } from "./modules/analytics/analytics.routes";
import { platformAuthRouter } from "./modules/platform-auth/platform-auth.routes";
import { platformTenantsRouter } from "./modules/platform-governance/platform-tenants.routes";
import { platformTelemetryRouter } from "./modules/platform-governance/platform-telemetry.routes";
import { platformTestingRouter } from "./modules/platform-governance/platform-testing.routes";
import { platformStaffRouter } from "./modules/platform-governance/platform-staff.routes";
import { platformPlansRouter } from "./modules/platform-governance/platform-plans.routes";
import { platformSubscriptionsRouter, platformPaymentsRouter } from "./modules/platform-governance/platform-subscriptions.routes";
import { platformSupportRouter } from "./modules/platform-governance/platform-support.routes";
import { supportTicketRouter } from "./modules/support/support-ticket.routes";
import { webchatRouter, webchatTenantRouter } from "./modules/webchat/webchat.routes";
import { ensureMediaBucketExists } from "./db/object-storage";
import { ensureSearchIndices } from "./db/elasticsearch";
import { realtimeGateway } from "./modules/realtime/websocket.service";
import { getPendingMigrations, describeBuild } from "./db/migration-status";

import { runFlowForConversation } from "./modules/flows/flow-engine-runner";
import { initFlowDelayWorker } from "./modules/jobs/queue.service";

dotenv.config();

const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    frameguard: false,
    contentSecurityPolicy: false,
  })
);
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(requestLogger);
/**
 * Capturing the raw bytes here (before parsing) is required for correct
 * webhook signature verification. Meta signs the literal request body it
 * sent, not a re-serialization of the parsed JSON — those two can differ in
 * whitespace, so re-serializing with JSON.stringify(req.body) and hashing
 * THAT (the original, buggier approach) only happens to work when the
 * sender's formatting coincidentally matches JSON.stringify's compact
 * output. See src/modules/webhooks/webhooks.routes.ts, which uses
 * req.rawBody instead.
 */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRouter);
app.use("/api/channels", channelsRouter);
app.use("/api/channels", linksRouter); // adds GET /api/channels/:channelId/deep-link
app.use("/api/contacts", contactsRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/flows", flowsRouter);
app.use("/api/deals", dealsRouter);
app.use("/api/campaigns", campaignsRouter);
app.use("/api/whatsapp-onboarding", whatsappOnboardingRouter);
app.use("/api/channels", templatesRouter); // adds GET/POST /api/channels/:channelId/templates
app.use("/api/search", searchRouter);
app.use("/api/media", mediaRouter);
app.use("/api/system", systemRouter);
app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/knowledge-bases", knowledgeBaseRouter);
app.use("/api/ai", aiRouter);
app.use("/api/audit-logs", auditRouter);
app.use("/api/api-keys", apiKeysRouter);
app.use("/api/team", teamRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/billing", billingRouter);
app.use("/api/compliance", complianceRouter);
app.use("/api/analytics", analyticsRouter);

// Platform Governance & Super Admin Routers (Phase 9)
app.use("/api/platform/auth", platformAuthRouter);
app.use("/api/platform/tenants", platformTenantsRouter);
app.use("/api/platform/telemetry", platformTelemetryRouter);
app.use("/api/platform/testing", platformTestingRouter);
app.use("/api/platform/staff", platformStaffRouter);
app.use("/api/platform/plans", platformPlansRouter);
app.use("/api/platform/subscriptions", platformSubscriptionsRouter);
app.use("/api/platform/payments", platformPaymentsRouter);
app.use("/api/platform/support", platformSupportRouter);

// Tenant Helpdesk & Support Tickets
app.use("/api/support/tickets", supportTicketRouter);

// Live Webchat Widget (Public Visitor & Tenant Management)
app.use("/api/webchat", webchatRouter);
app.use("/api/channels/webchat", webchatTenantRouter);

app.use("/api/webhooks/subscriptions", outgoingWebhooksRouter);
app.use("/webhooks/payments", paymentWebhooksRouter);
app.use("/webhooks", webhooksRouter);

// Global production-grade error handler
app.use(errorHandler);

process.on("unhandledRejection", (reason: any) => {
  logger.error(
    "Unhandled promise rejection (check for a raw Promise outside asyncHandler):",
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

process.on("uncaughtException", (err: Error) => {
  logger.fatal("Uncaught Exception thrown in Node process:", err);
});

const server = http.createServer(app);

// Initialize Realtime WebSocket Gateway & Redis Pub/Sub
realtimeGateway.init(server).catch((err) => {
  logger.error("Failed to initialize realtime WebSocket gateway:", err);
});

const port = Number(process.env.PORT) || 4000;
server.listen(port, () => {
  logger.info(`omni-platform backend listening on :${port}`);
  logger.info(`build: ${describeBuild()}`);

  // Migrations are manual (`npm run migrate` / `migrate:prod`): shout if this build is running on an old schema
  getPendingMigrations()
    .then((pending) => {
      if (pending.length > 0) {
        logger.error(
          `DATABASE MIGRATIONS PENDING: ${pending.join(", ")}. This build expects them; run "npm run migrate:prod" ` +
            `(compiled) or "npm run migrate" and restart. Features that depend on them will fail until then.`
        );
      } else {
        logger.info("Database schema is up to date (no pending migrations)");
      }
    })
    .catch((err) => logger.error("Could not check pending migrations:", err));
});

/**
 * Bucket auto-creation only makes sense against a local/dev MinIO — see the
 * comment on ensureMediaBucketExists. Real AWS S3 usage should leave
 * MEDIA_S3_ENDPOINT unset and provision the bucket via infra tooling
 * instead. Either way, a storage outage at boot shouldn't crash the API —
 * media features degrade, the rest of the app still works.
 */
if (process.env.MEDIA_S3_ENDPOINT) {
  ensureMediaBucketExists().catch((err) =>
    console.error("[startup] failed to ensure media bucket exists (non-fatal):", err)
  );
}

/**
 * Same non-fatal-at-boot treatment for Elasticsearch — see
 * IMPLEMENTATION_TRACKER.md for why this hasn't been live-tested in every
 * environment. Search degrades gracefully if this fails; message/webhook
 * handling never depends on it.
 */
ensureSearchIndices().catch((err) =>
  console.error("[startup] failed to ensure Elasticsearch indices exist (non-fatal):", err)
);

/**
 * Drip-campaign polling. This is a stand-in for a real scheduler/job queue
 * (see architecture doc §7 and the comment on processDueDripSteps) — good
 * enough for development and low volume, not for production scale. The
 * interval is configurable via DRIP_POLL_INTERVAL_MS (defaults to 30s) —
 * a step can fire up to one interval late, fine for hour/day-granularity
 * drip delays but worth knowing.
 */
const DRIP_POLL_INTERVAL_MS = Number(process.env.DRIP_POLL_INTERVAL_MS) || 30_000;
const dripLog = logger.child({ module: "drip-scheduler" });
let dripPassRunning = false;
dripLog.info(`drip scheduler polling every ${DRIP_POLL_INTERVAL_MS}ms`);
initDripSchedulerStatus(DRIP_POLL_INTERVAL_MS);
setInterval(async () => {
  // A slow pass must not overlap the next one: both would pick up the same pending recipients.
  if (dripPassRunning) return;
  dripPassRunning = true;
  try {
    const result = await processDueDripSteps();
    recordDripRunSuccess(result);
    if (result.processed || result.failed) {
      dripLog.info(`processed=${result.processed} failed=${result.failed}`);
    }
  } catch (err) {
    recordDripRunError(err);
    dripLog.error("error running due drip steps", err);
  } finally {
    dripPassRunning = false;
  }
}, DRIP_POLL_INTERVAL_MS);

/**
 * Initialize BullMQ Flow Delay Worker for Wait nodes & automated retry loops
 */
initFlowDelayWorker(async (jobData) => {
  try {
    await runFlowForConversation({
      tenantId: jobData.tenantId,
      conversationId: jobData.conversationId,
      defaultFlowId: null,
      resumeAtNodeId: jobData.targetNodeId,
    });
  } catch (err) {
    console.error(`[flow-delay-worker] Error resuming flow for conversation ${jobData.conversationId}:`, err);
  }
});
