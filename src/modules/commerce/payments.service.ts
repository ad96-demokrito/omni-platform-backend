import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../../db/pool";
import { getOrder, setOrderPaymentLink, updateOrderStatus } from "./orders.service";
import { logger } from "../../utils/logger";

export interface PaymentTransaction {
  id: string;
  tenant_id: string;
  tenantId?: string;
  order_id: string;
  orderId?: string;
  gateway: "razorpay" | "stripe" | "whatsapp_pay" | "manual";
  gateway_order_id: string | null;
  gatewayOrderId?: string | null;
  gateway_payment_id: string | null;
  gatewayPaymentId?: string | null;
  amount: number;
  currency: string;
  status: "created" | "success" | "failed" | "refunded";
  raw_response: Record<string, any>;
  rawResponse?: Record<string, any>;
  created_at: string;
  createdAt?: string;
  updated_at: string;
  updatedAt?: string;
}

interface PaymentTransactionRow {
  id: string;
  tenant_id: string;
  order_id: string;
  gateway: "razorpay" | "stripe" | "whatsapp_pay" | "manual";
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  amount: string | number;
  currency: string;
  status: "created" | "success" | "failed" | "refunded";
  raw_response: any;
  created_at: string;
  updated_at: string;
}

function formatTransaction(row: PaymentTransactionRow): PaymentTransaction {
  const amount = typeof row.amount === "number" ? row.amount : parseFloat(row.amount || "0");
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    tenantId: row.tenant_id,
    order_id: row.order_id,
    orderId: row.order_id,
    gateway: row.gateway,
    gateway_order_id: row.gateway_order_id,
    gatewayOrderId: row.gateway_order_id,
    gateway_payment_id: row.gateway_payment_id,
    gatewayPaymentId: row.gateway_payment_id,
    amount,
    currency: row.currency,
    status: row.status,
    raw_response: row.raw_response || {},
    rawResponse: row.raw_response || {},
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
  };
}

export async function createPaymentTransaction(
  tenantId: string,
  data: {
    orderId: string;
    gateway: "razorpay" | "stripe" | "whatsapp_pay" | "manual";
    amount: number;
    currency?: string;
    gatewayOrderId?: string | null;
    gatewayPaymentId?: string | null;
    status?: "created" | "success" | "failed" | "refunded";
    rawResponse?: Record<string, any>;
  }
): Promise<PaymentTransaction> {
  const id = uuidv4();
  const currency = data.currency || "INR";
  const status = data.status || "created";
  const rawResponse = JSON.stringify(data.rawResponse || {});

  const row = await queryOne<PaymentTransactionRow>(
    `INSERT INTO payment_transactions (
      id, tenant_id, order_id, gateway, gateway_order_id,
      gateway_payment_id, amount, currency, status, raw_response
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      id,
      tenantId,
      data.orderId,
      data.gateway,
      data.gatewayOrderId || null,
      data.gatewayPaymentId || null,
      data.amount,
      currency,
      status,
      rawResponse,
    ]
  );

  if (!row) throw new Error("Failed to insert payment transaction");
  return formatTransaction(row);
}

export async function listPaymentTransactions(
  tenantId: string,
  orderId?: string
): Promise<PaymentTransaction[]> {
  const conditions = ["tenant_id = $1"];
  const params: any[] = [tenantId];

  if (orderId) {
    conditions.push("order_id = $2");
    params.push(orderId);
  }

  const rows = await query<PaymentTransactionRow>(
    `SELECT * FROM payment_transactions
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC`,
    params
  );

  return rows.map(formatTransaction);
}

/**
 * Create a Razorpay Payment Link for an order
 */
export async function createRazorpayPaymentLink(
  tenantId: string,
  orderId: string,
  options: {
    keyId?: string;
    keySecret?: string;
    callbackUrl?: string;
  } = {}
): Promise<{ paymentLink: string; paymentId?: string }> {
  const order = await getOrder(tenantId, orderId);
  if (!order) throw new Error("Order not found");

  const keyId = options.keyId || process.env.RAZORPAY_KEY_ID;
  const keySecret = options.keySecret || process.env.RAZORPAY_KEY_SECRET;

  const amountInPaise = Math.round(order.total_amount * 100);

  if (!keyId || !keySecret) {
    // Demo / fallback mode for local testing without active Razorpay account
    const fallbackLink = `https://rzp.io/l/demo_${order.order_number}`;
    await setOrderPaymentLink(tenantId, orderId, fallbackLink, "razorpay");
    await createPaymentTransaction(tenantId, {
      orderId,
      gateway: "razorpay",
      amount: order.total_amount,
      currency: order.currency,
      gatewayOrderId: `plink_demo_${order.order_number}`,
      status: "created",
      rawResponse: { note: "Generated in test/demo mode without Razorpay credentials" },
    });
    return { paymentLink: fallbackLink, paymentId: `plink_demo_${order.order_number}` };
  }

  const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  const payload = {
    amount: amountInPaise,
    currency: order.currency || "INR",
    accept_partial: false,
    reference_id: order.order_number,
    description: `Payment for Order #${order.order_number}`,
    customer: {
      name: order.contact_name || undefined,
      contact: order.contact_external_id || undefined,
    },
    notify: {
      sms: false,
      email: false,
    },
    reminder_enable: false,
    notes: {
      orderId: order.id,
      tenantId: tenantId,
      orderNumber: order.order_number,
    },
    callback_url: options.callbackUrl,
    callback_method: "get",
  };

  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(payload),
  });

  const resJson = (await response.json()) as any;
  if (!response.ok) {
    logger.error("Razorpay Payment Link API error:", resJson);
    throw new Error(resJson?.error?.description || "Failed to create Razorpay Payment Link");
  }

  const paymentLink = resJson.short_url || resJson.url;
  const paymentLinkId = resJson.id;

  await setOrderPaymentLink(tenantId, orderId, paymentLink, "razorpay");
  await createPaymentTransaction(tenantId, {
    orderId,
    gateway: "razorpay",
    amount: order.total_amount,
    currency: order.currency,
    gatewayOrderId: paymentLinkId,
    status: "created",
    rawResponse: resJson,
  });

  return { paymentLink, paymentId: paymentLinkId };
}

/**
 * Create a Stripe Checkout Session for an order
 */
export async function createStripePaymentLink(
  tenantId: string,
  orderId: string,
  options: {
    secretKey?: string;
    successUrl?: string;
    cancelUrl?: string;
  } = {}
): Promise<{ paymentLink: string; sessionId?: string }> {
  const order = await getOrder(tenantId, orderId);
  if (!order) throw new Error("Order not found");

  const secretKey = options.secretKey || process.env.STRIPE_SECRET_KEY;
  const amountInCents = Math.round(order.total_amount * 100);

  if (!secretKey) {
    // Demo / fallback mode for local testing without active Stripe account
    const fallbackLink = `https://checkout.stripe.com/c/pay/demo_${order.order_number}`;
    await setOrderPaymentLink(tenantId, orderId, fallbackLink, "stripe");
    await createPaymentTransaction(tenantId, {
      orderId,
      gateway: "stripe",
      amount: order.total_amount,
      currency: order.currency,
      gatewayOrderId: `cs_demo_${order.order_number}`,
      status: "created",
      rawResponse: { note: "Generated in test/demo mode without Stripe credentials" },
    });
    return { paymentLink: fallbackLink, sessionId: `cs_demo_${order.order_number}` };
  }

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price_data][currency]", (order.currency || "INR").toLowerCase());
  params.append(
    "line_items[0][price_data][product_data][name]",
    `Order #${order.order_number}`
  );
  params.append("line_items[0][price_data][unit_amount]", String(amountInCents));
  params.append("line_items[0][quantity]", "1");
  params.append("client_reference_id", order.id);
  params.append("metadata[tenantId]", tenantId);
  params.append("metadata[orderId]", order.id);
  params.append("metadata[orderNumber]", order.order_number);
  params.append(
    "success_url",
    options.successUrl || "https://omni-platform.ad96.in/orders?status=success"
  );
  params.append(
    "cancel_url",
    options.cancelUrl || "https://omni-platform.ad96.in/orders?status=cancelled"
  );

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${secretKey}`,
    },
    body: params.toString(),
  });

  const resJson = (await response.json()) as any;
  if (!response.ok) {
    logger.error("Stripe Checkout Session API error:", resJson);
    throw new Error(resJson?.error?.message || "Failed to create Stripe Checkout Session");
  }

  const paymentLink = resJson.url;
  const sessionId = resJson.id;

  await setOrderPaymentLink(tenantId, orderId, paymentLink, "stripe");
  await createPaymentTransaction(tenantId, {
    orderId,
    gateway: "stripe",
    amount: order.total_amount,
    currency: order.currency,
    gatewayOrderId: sessionId,
    status: "created",
    rawResponse: resJson,
  });

  return { paymentLink, sessionId };
}

/**
 * Reconcile Razorpay Webhook Event
 */
export async function handleRazorpayWebhook(
  rawBody: Buffer | string,
  signature: string | undefined,
  body: any
): Promise<{ success: boolean; message: string }> {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (expectedSignature !== signature) {
      logger.warn("Razorpay Webhook signature verification failed");
      return { success: false, message: "Invalid webhook signature" };
    }
  }

  const event = body?.event;
  const payload = body?.payload;

  logger.info(`Processing Razorpay webhook event: ${event}`);

  if (event === "payment_link.paid" || event === "payment.captured" || event === "order.paid") {
    const entity =
      payload?.payment_link?.entity || payload?.payment?.entity || payload?.order?.entity;
    const orderNumber = entity?.reference_id || entity?.notes?.orderNumber;
    const orderId = entity?.notes?.orderId;
    const tenantId = entity?.notes?.tenantId;
    const paymentId = entity?.id || payload?.payment?.entity?.id;

    if (orderId && tenantId) {
      await updateOrderStatus(tenantId, orderId, "paid", "captured");
      await createPaymentTransaction(tenantId, {
        orderId,
        gateway: "razorpay",
        amount: (entity.amount || 0) / 100,
        currency: entity.currency || "INR",
        gatewayOrderId: entity.id,
        gatewayPaymentId: paymentId,
        status: "success",
        rawResponse: body,
      });
      logger.info(`Order ${orderId} successfully marked as PAID from Razorpay webhook`);
      return { success: true, message: `Order ${orderId} updated to paid` };
    } else if (orderNumber) {
      // Lookup order by order_number
      const orderRow = await queryOne<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM orders WHERE order_number = $1",
        [orderNumber]
      );
      if (orderRow) {
        await updateOrderStatus(orderRow.tenant_id, orderRow.id, "paid", "captured");
        await createPaymentTransaction(orderRow.tenant_id, {
          orderId: orderRow.id,
          gateway: "razorpay",
          amount: (entity.amount || 0) / 100,
          currency: entity.currency || "INR",
          gatewayOrderId: entity.id,
          gatewayPaymentId: paymentId,
          status: "success",
          rawResponse: body,
        });
        return { success: true, message: `Order ${orderRow.id} updated to paid` };
      }
    }
  }

  return { success: true, message: "Event received" };
}

/**
 * Reconcile Stripe Webhook Event
 */
export async function handleStripeWebhook(body: any): Promise<{ success: boolean; message: string }> {
  const eventType = body?.type;
  const dataObject = body?.data?.object;

  logger.info(`Processing Stripe webhook event: ${eventType}`);

  if (eventType === "checkout.session.completed" || eventType === "payment_intent.succeeded") {
    const orderId = dataObject?.client_reference_id || dataObject?.metadata?.orderId;
    const tenantId = dataObject?.metadata?.tenantId;
    const paymentId = dataObject?.payment_intent || dataObject?.id;
    const amount = (dataObject?.amount_total || dataObject?.amount || 0) / 100;
    const currency = dataObject?.currency?.toUpperCase() || "INR";

    if (orderId) {
      // Find tenant_id if not present in metadata
      let resolvedTenantId = tenantId;
      if (!resolvedTenantId) {
        const orderRow = await queryOne<{ tenant_id: string }>(
          "SELECT tenant_id FROM orders WHERE id = $1",
          [orderId]
        );
        resolvedTenantId = orderRow?.tenant_id;
      }

      if (resolvedTenantId) {
        await updateOrderStatus(resolvedTenantId, orderId, "paid", "captured");
        await createPaymentTransaction(resolvedTenantId, {
          orderId,
          gateway: "stripe",
          amount,
          currency,
          gatewayOrderId: dataObject.id,
          gatewayPaymentId: String(paymentId),
          status: "success",
          rawResponse: body,
        });
        logger.info(`Order ${orderId} successfully marked as PAID from Stripe webhook`);
        return { success: true, message: `Order ${orderId} updated to paid` };
      }
    }
  }

  return { success: true, message: "Event received" };
}
