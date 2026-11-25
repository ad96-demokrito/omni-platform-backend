import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  createPaymentTransaction,
  createRazorpayPaymentLink,
  createStripePaymentLink,
  listPaymentTransactions,
} from "./payments.service";
import { handleRazorpayWebhookRequest, handleStripeWebhookRequest } from "../billing/payment-webhooks";

export const paymentsRouter = Router();

// ==========================================
// Authenticated API Routes
// ==========================================

// GET /api/payments/transactions - List payment transactions
paymentsRouter.get(
  "/transactions",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { orderId } = req.query;

    const transactions = await listPaymentTransactions(
      tenantId,
      typeof orderId === "string" ? orderId : undefined
    );

    res.json({ transactions });
  })
);

// POST /api/payments/razorpay/link - Generate Razorpay Payment Link
paymentsRouter.post(
  "/razorpay/link",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { orderId, callbackUrl, keyId, keySecret } = req.body;

    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "orderId is required" });
    }

    const result = await createRazorpayPaymentLink(tenantId, orderId, {
      callbackUrl,
      keyId,
      keySecret,
    });

    res.json(result);
  })
);

// POST /api/payments/stripe/link - Generate Stripe Checkout Session Link
paymentsRouter.post(
  "/stripe/link",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { orderId, successUrl, cancelUrl, secretKey } = req.body;

    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "orderId is required" });
    }

    const result = await createStripePaymentLink(tenantId, orderId, {
      successUrl,
      cancelUrl,
      secretKey,
    });

    res.json(result);
  })
);

// POST /api/payments/manual - Record manual payment (Cash on Delivery / Bank Transfer / POS)
paymentsRouter.post(
  "/manual",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { orderId, amount, currency, reference } = req.body;

    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "orderId is required" });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Valid amount is required" });
    }

    const transaction = await createPaymentTransaction(tenantId, {
      orderId,
      gateway: "manual",
      amount,
      currency: currency || "INR",
      gatewayPaymentId: reference || `MANUAL-${Date.now()}`,
      status: "success",
      rawResponse: { recordedBy: req.auth!.userId, reference },
    });

    res.status(201).json({ transaction });
  })
);

// ==========================================
// Public Webhook Handlers for Payment Gateways
// ==========================================
export const paymentWebhooksRouter = Router();

// POST /webhooks/payments/razorpay
paymentWebhooksRouter.post(
  "/razorpay",
  asyncHandler(async (req, res) => {
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody) return res.status(400).json({ error: "Missing request body" });

    const result = await handleRazorpayWebhookRequest(
      rawBody,
      req.headers["x-razorpay-signature"] as string | undefined,
      req.headers["x-razorpay-event-id"] as string | undefined,
      req.body
    );
    res.status(result.status).json(result.json);
  })
);

// POST /webhooks/payments/stripe
paymentWebhooksRouter.post(
  "/stripe",
  asyncHandler(async (req, res) => {
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody) return res.status(400).json({ error: "Missing request body" });

    const result = await handleStripeWebhookRequest(
      rawBody,
      req.headers["stripe-signature"] as string | undefined,
      req.body
    );
    res.status(result.status).json(result.json);
  })
);
