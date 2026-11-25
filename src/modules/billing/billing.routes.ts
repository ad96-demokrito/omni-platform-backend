import { Router, Response } from "express";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { BillingService } from "./billing.service";
import {
  cancelSubscription,
  getSubscriptionSummary,
  openBillingPortal,
  sandboxFailRenewal,
  sandboxRenew,
} from "./subscription.service";
import { asyncHandler } from "../../middleware/async-handler";
import { httpError, isUuid } from "../../utils/http-error";
import { getDocumentPdf, getInvoicePdf } from "./invoice-pdf.service";
import { getCreditNote, listCreditNotes } from "./credit-notes.service";

export const billingRouter = Router();

billingRouter.use(requireAuth);

/**
 * GET /api/billing/usage
 * Get real-time usage consumption and plan limits
 */
billingRouter.get(
  "/usage",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const summary = await BillingService.getUsageAndQuotas(tenantId);
    res.json(summary);
  })
);

/**
 * GET /api/billing/profile
 * Billing country, currency and tax details of the workspace.
 */
billingRouter.get(
  "/profile",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await BillingService.getBillingProfile(req.auth!.tenantId));
  })
);

/**
 * PUT /api/billing/profile
 * Update billing country (decides the currency), tax ID (GSTIN for India), name and address.
 * The country/currency is locked after the first paid payment.
 */
billingRouter.put(
  "/profile",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { country, taxId, name, address, stateCode } = req.body || {};
    const profile = await BillingService.updateBillingProfile({
      tenantId: req.auth!.tenantId,
      actorId: req.auth!.userId,
      actorEmail: req.auth!.email,
      country,
      taxId,
      name,
      address,
      stateCode,
      ipAddress: req.ip,
    });
    res.json(profile);
  })
);

/**
 * POST /api/billing/checkout
 * Starts a plan purchase. The server decides the price (workspace currency + GST) and the gateway
 * (INR -> Razorpay, otherwise Stripe); the body only picks the plan and billing cycle.
 */
billingRouter.post(
  "/checkout",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const actorEmail = req.auth!.email;
    const { planId, billingCycle = "monthly", autoRenew } = req.body || {};

    if (!planId || typeof planId !== "string") {
      return res.status(400).json({ error: "Plan tier identifier is required" });
    }
    if (billingCycle !== "monthly" && billingCycle !== "yearly") {
      return res.status(400).json({ error: "billingCycle must be 'monthly' or 'yearly'" });
    }

    const session = await BillingService.createCheckoutSession({
      tenantId,
      actorId,
      actorEmail,
      planId,
      billingCycle,
      autoRenew: autoRenew === true,
    });

    res.json(session);
  })
);

/**
 * GET /api/billing/checkout/:sessionId/status
 * Where a checkout stands. Asks the payment provider directly and activates the plan if it was paid, so it
 * works whether or not the webhook has arrived. :sessionId is the provider session id (cs_... / plink_...)
 * the browser comes back with, or the checkout id. Another workspace's checkout is a 404.
 */
billingRouter.get(
  "/checkout/:sessionId/status",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const sessionId = req.params.sessionId;
    if (!sessionId || sessionId.length > 200) {
      return res.status(400).json({ error: "A valid checkout session id is required" });
    }
    res.json(await BillingService.getCheckoutStatus(req.auth!.tenantId, sessionId));
  })
);

/**
 * GET /api/billing/subscription
 * The workspace's auto-renewing subscription (status, next renewal, price), or null if it has none.
 */
billingRouter.get(
  "/subscription",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json({ subscription: await getSubscriptionSummary(req.auth!.tenantId) });
  })
);

/**
 * POST /api/billing/subscription/cancel
 * Stops renewals. The plan stays active until the period already paid for ends. Idempotent.
 */
billingRouter.post(
  "/subscription/cancel",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const subscription = await cancelSubscription(req.auth!.tenantId, {
      userId: req.auth!.userId,
      email: req.auth!.email,
      ipAddress: req.ip,
    });
    res.json({ subscription });
  })
);

/**
 * POST /api/billing/subscription/portal
 * URL of Stripe's hosted page for updating the card (card subscriptions only).
 */
billingRouter.post(
  "/subscription/portal",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json({ url: await openBillingPortal(req.auth!.tenantId) });
  })
);

/**
 * POST /api/billing/subscription/sandbox/renew | /fail  (development only, BILLING_SANDBOX=true)
 * Simulate the next automatic renewal, or a failed one, of a sandbox subscription. 404 everywhere else.
 */
billingRouter.post(
  "/subscription/sandbox/renew",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json({ subscription: await sandboxRenew(req.auth!.tenantId) });
  })
);
billingRouter.post(
  "/subscription/sandbox/fail",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json({ subscription: await sandboxFailRenewal(req.auth!.tenantId) });
  })
);

/**
 * POST /api/billing/verify-payment (removed)
 * It activated a plan from a payment reference the browser supplied, so anyone could upgrade for free.
 * Activation now only follows a provider-confirmed payment: see the checkout status route above.
 */
billingRouter.post("/verify-payment", (_req, res: Response) => {
  res.status(410).json({
    error: "This endpoint was removed. Check a checkout with GET /api/billing/checkout/:sessionId/status.",
  });
});

/**
 * POST /api/billing/plan
 * Switch to a FREE plan (owner/admin). Paid plans are only available through checkout.
 */
billingRouter.post(
  "/plan",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const actorEmail = req.auth!.email;
    const { planId } = req.body;

    if (!planId || typeof planId !== "string") {
      return res.status(400).json({ error: "Plan tier identifier is required (e.g. free, starter, pro, enterprise)" });
    }

    const result = await BillingService.updatePlan({
      tenantId,
      actorId,
      actorEmail,
      planId,
      ipAddress: req.ip,
    });

    res.json(result);
  })
);

/**
 * GET /api/billing/upgrade-quote?planId=pro&billingCycle=monthly
 * Preview of an upgrade: the new plan with GST, the credit for the unused time of the current plan, the amount to pay.
 */
billingRouter.get(
  "/upgrade-quote",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const planId = typeof req.query.planId === "string" ? req.query.planId.trim() : "";
    const billingCycle = req.query.billingCycle === "yearly" ? "yearly" : "monthly";
    if (!planId || planId.length > 64) throw httpError(400, "planId is required");
    res.json(await BillingService.getUpgradeQuote(req.auth!.tenantId, planId, billingCycle));
  })
);

/**
 * GET /api/billing/credit-notes
 * The workspace's credit notes (refunds, and the credit of an upgrade), newest first.
 */
billingRouter.get(
  "/credit-notes",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json({ creditNotes: await listCreditNotes({ tenantId: req.auth!.tenantId, limit: 50 }) });
  })
);

/** GET /api/billing/credit-notes/:id/pdf. Another workspace's credit note answers 404. */
billingRouter.get(
  "/credit-notes/:id/pdf",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const note = await getCreditNote(req.params.id, req.auth!.tenantId);
    const result = note ? await getDocumentPdf("credit_note", note.id, req.auth!.tenantId) : null;
    if (!result) throw httpError(404, "Credit note not found");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(result.pdf);
  })
);

/**
 * GET /api/billing/invoices/:id/pdf
 * The invoice as a PDF. Another workspace's invoice answers 404, exactly like one that does not exist.
 */
billingRouter.get(
  "/invoices/:id/pdf",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const result = isUuid(req.params.id) ? await getInvoicePdf(req.params.id, req.auth!.tenantId) : null;
    if (!result) throw httpError(404, "Invoice not found");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(result.pdf);
  })
);

/**
 * GET /api/billing/invoices
 * Get payment and invoice history for the current tenant workspace
 */
billingRouter.get(
  "/invoices",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const invoices = await BillingService.getInvoices(tenantId);
    res.json({ invoices });
  })
);
