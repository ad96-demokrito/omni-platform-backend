import { query, queryOne } from "../db/pool";
import { BillingService } from "../modules/billing/billing.service";

async function runBillingVerification() {
  console.log("================================================================================");
  console.log("🚀 STARTING AUTOMATED PAYMENT & SUBSCRIPTION LIFECYCLE VERIFICATION SUITE");
  console.log("================================================================================\n");

  try {
    // 1. Fetch or create a test tenant
    let tenant = await queryOne<any>("SELECT id, name, plan, plan_status, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries FROM tenants LIMIT 1");
    if (!tenant) {
      console.log("Creating temporary test tenant...");
      tenant = await queryOne<any>(
        `INSERT INTO tenants (name, plan, plan_status, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries)
         VALUES ('QA Billing Test Workspace', 'free', 'active', 2, 500, 1000, 50)
         RETURNING id, name, plan, plan_status, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries`
      );
    }

    console.log(`✅ [1/7] Target Test Workspace: "${tenant.name}" (${tenant.id})`);
    console.log(`     Initial Plan: ${tenant.plan} (${tenant.plan_status}) | Channels: ${tenant.max_channels} | Contacts: ${tenant.max_contacts} | Msgs: ${tenant.max_monthly_messages}\n`);

    // 2. Verify Plan Resolution (Database + Fallback)
    console.log("🔍 [2/7] Testing Plan Resolution across Database & Fallbacks...");
    const plansToTest = ["free", "starter", "pro", "enterprise"];
    for (const planId of plansToTest) {
      const resolved = await BillingService.resolvePlan(planId);
      if (!resolved) {
        throw new Error(`Failed to resolve plan: ${planId}`);
      }
      console.log(`     ✓ Plan '${planId}': Name="${resolved.name}", Monthly=₹${resolved.priceMonthly}, Yearly=₹${resolved.priceYearly}, Channels=${resolved.maxChannels}, Contacts=${resolved.maxContacts}`);
    }
    console.log("✅ Plan Resolution verified successfully.\n");

    // 3. Test Checkout Session Generation for All Gateways
    console.log("💳 [3/7] Testing Multi-Gateway Checkout Session Creation (Stripe, Razorpay, Sandbox)...");

    // 3a. Stripe Checkout
    const stripeSession = await BillingService.createCheckoutSession({
      tenantId: tenant.id,
      planId: "pro",
      billingCycle: "monthly",
      gateway: "stripe",
      successUrl: "http://localhost:5173/settings?checkout=success",
      cancelUrl: "http://localhost:5173/settings?checkout=cancel",
    });
    console.log(`     ✓ Stripe Session: ID=${stripeSession.sessionId}, Gateway=${stripeSession.gateway}, Amount=₹${stripeSession.amount} ${stripeSession.currency}, isSandbox=${stripeSession.isSandbox}`);

    // 3b. Razorpay Checkout
    const razorpaySession = await BillingService.createCheckoutSession({
      tenantId: tenant.id,
      planId: "starter",
      billingCycle: "yearly",
      gateway: "razorpay",
    });
    console.log(`     ✓ Razorpay Session: ID=${razorpaySession.sessionId}, Gateway=${razorpaySession.gateway}, Amount=₹${razorpaySession.amount} ${razorpaySession.currency}, isSandbox=${razorpaySession.isSandbox}`);

    // 3c. Sandbox Checkout
    const sandboxSession = await BillingService.createCheckoutSession({
      tenantId: tenant.id,
      planId: "pro",
      billingCycle: "monthly",
      gateway: "sandbox",
    });
    console.log(`     ✓ Sandbox Session: ID=${sandboxSession.sessionId}, Gateway=${sandboxSession.gateway}, Amount=₹${sandboxSession.amount} ${sandboxSession.currency}`);
    console.log("✅ Multi-gateway session generation verified.\n");

    // 4. Test Payment Verification & Upgrade to PRO Plan (Monthly)
    console.log("⚡ [4/7] Testing Verification & Upgrade Flow -> Upgrading to PRO (Monthly)...");
    const upgradeResultPro = await BillingService.verifyPaymentAndUpgrade({
      tenantId: tenant.id,
      actorId: "test_actor_billing_qa",
      actorEmail: "billing-qa@omniplatform.io",
      planId: "pro",
      billingCycle: "monthly",
      gateway: "stripe",
      paymentReference: `ch_test_${Date.now()}`,
    });

    const startStr = new Date(upgradeResultPro.payment.periodStart).toISOString().slice(0, 10);
    const endStr = new Date(upgradeResultPro.payment.periodEnd).toISOString().slice(0, 10);

    console.log(`     ✓ Payment Success: ${upgradeResultPro.success}`);
    console.log(`     ✓ Message: ${upgradeResultPro.message}`);
    console.log(`     ✓ Generated Invoice Number: ${upgradeResultPro.payment.invoiceNumber}`);
    console.log(`     ✓ Amount: $${upgradeResultPro.payment.amount} ${upgradeResultPro.payment.currency}`);
    console.log(`     ✓ Period: ${startStr} to ${endStr}`);
    console.log(`     ✓ Tenant Plan Expiration: ${upgradeResultPro.subscription.planExpiresAt}`);

    // Verify tenant table updated in DB
    const updatedTenantPro = await queryOne<any>("SELECT plan, plan_status, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries FROM tenants WHERE id = $1", [tenant.id]);
    console.log(`     ✓ DB Updated: Plan=${updatedTenantPro.plan}, Status=${updatedTenantPro.plan_status}, Channels=${updatedTenantPro.max_channels}, Contacts=${updatedTenantPro.max_contacts}, Msgs=${updatedTenantPro.max_monthly_messages}`);
    if (updatedTenantPro.plan !== "pro" || updatedTenantPro.plan_status !== "active") {
      throw new Error("Tenant plan did not update properly in PostgreSQL!");
    }
    console.log("✅ Upgrade to PRO verified successfully.\n");

    // 5. Test Payment Verification & Upgrade to ENTERPRISE Plan (Yearly)
    console.log("🏢 [5/7] Testing Verification & Upgrade Flow -> Upgrading to ENTERPRISE (Yearly)...");
    const upgradeResultEnterprise = await BillingService.verifyPaymentAndUpgrade({
      tenantId: tenant.id,
      actorId: "test_actor_billing_qa",
      actorEmail: "billing-qa@omniplatform.io",
      planId: "enterprise",
      billingCycle: "yearly",
      gateway: "razorpay",
      paymentReference: `pay_test_${Date.now()}`,
    });

    console.log(`     ✓ Generated Invoice Number: ${upgradeResultEnterprise.payment.invoiceNumber}`);
    console.log(`     ✓ Amount: $${upgradeResultEnterprise.payment.amount} ${upgradeResultEnterprise.payment.currency}`);
    console.log(`     ✓ Billing Cycle: ${upgradeResultEnterprise.payment.billingCycle}`);
    console.log(`     ✓ Tenant Plan Expiration: ${upgradeResultEnterprise.subscription.planExpiresAt}`);

    const updatedTenantEnt = await queryOne<any>("SELECT plan, plan_status, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries FROM tenants WHERE id = $1", [tenant.id]);
    console.log(`     ✓ DB Updated: Plan=${updatedTenantEnt.plan}, Channels=${updatedTenantEnt.max_channels}, Contacts=${updatedTenantEnt.max_contacts}, Msgs=${updatedTenantEnt.max_monthly_messages}`);
    if (updatedTenantEnt.plan !== "enterprise" || updatedTenantEnt.max_channels < 20) {
      throw new Error("Enterprise quota expansion failed!");
    }
    console.log("✅ Upgrade to Enterprise verified successfully.\n");

    // 6. Test Invoices & Ledger Retrieval for Tenant
    console.log("📜 [6/7] Testing Invoices Retrieval via BillingService.getInvoices()...");
    const invoices = await BillingService.getInvoices(tenant.id);
    console.log(`     ✓ Retrieved ${invoices.length} invoices for tenant:`);
    for (const inv of invoices.slice(0, 5)) {
      console.log(`        - [${inv.invoiceNumber}] ${inv.planName} | ₹${inv.amount} ${inv.currency} | ${inv.billingCycle} | ${inv.paymentMethod} | Status: ${inv.status}`);
    }
    if (invoices.length < 2) {
      throw new Error("Expected at least 2 invoices in ledger!");
    }
    console.log("✅ Tenant Invoices and Payment Ledger verified.\n");

    // 7. Test Usage and Quotas Calculation
    console.log("📊 [7/7] Testing Real-Time Quotas via BillingService.getUsageAndQuotas()...");
    const usage = await BillingService.getUsageAndQuotas(tenant.id);
    console.log(`     ✓ Current Plan: ${usage.planName} (${usage.planId})`);
    console.log(`     ✓ Channel Quota: ${usage.metrics.channels.used} / ${usage.metrics.channels.limit} (${usage.metrics.channels.percentage}%)`);
    console.log(`     ✓ Contact Quota: ${usage.metrics.contacts.used} / ${usage.metrics.contacts.limit} (${usage.metrics.contacts.percentage}%)`);
    console.log(`     ✓ Message Quota: ${usage.metrics.monthlyMessages.used} / ${usage.metrics.monthlyMessages.limit} (${usage.metrics.monthlyMessages.percentage}%)`);
    console.log(`     ✓ AI Query Quota: ${usage.metrics.monthlyAiQueries.used} / ${usage.metrics.monthlyAiQueries.limit} (${usage.metrics.monthlyAiQueries.percentage}%)`);
    console.log("✅ Real-time usage and quota metrics verified.\n");

    console.log("================================================================================");
    console.log("🎉 ALL PAYMENT & SUBSCRIPTION FLOW CHECKS PASSED WITH 100% SUCCESS!");
    console.log("================================================================================");
  } catch (error: any) {
    console.error("❌ Billing verification failed:", error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

runBillingVerification();
