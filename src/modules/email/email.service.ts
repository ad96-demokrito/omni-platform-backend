import nodemailer, { Transporter } from "nodemailer";
import { logger } from "../../utils/logger";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  /** Silent copy, for example the accountant's address for invoices. */
  bcc?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

export interface EmailLogEntry {
  id: string;
  to: string | string[];
  subject: string;
  from: string;
  sentAt: string;
  status: "sent" | "simulated" | "failed";
  error?: string;
  previewSnippet: string;
}

class EmailService {
  private transporter: Transporter | null = null;
  private isConfigured: boolean = false;
  private recentLogs: EmailLogEntry[] = [];
  private maxLogs: number = 50;

  constructor() {
    this.initTransporter();
  }

  private initTransporter(): void {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const secure = process.env.SMTP_SECURE === "true" || port === 465;

    if (host && user && pass) {
      try {
        this.transporter = nodemailer.createTransport({
          host,
          port,
          secure,
          auth: { user, pass },
          tls: { rejectUnauthorized: false },
        });
        this.isConfigured = true;
        logger.info(`[EmailService] SMTP transporter initialized for host: ${host}:${port}`);
      } catch (err) {
        logger.error("[EmailService] Failed to initialize SMTP transporter:", err);
        this.isConfigured = false;
      }
    } else {
      logger.info("[EmailService] SMTP credentials not fully configured. Running in sandbox/simulation mode.");
      this.isConfigured = false;
    }
  }

  public getStatus() {
    return {
      isConfigured: this.isConfigured,
      smtpHost: process.env.SMTP_HOST || "not_configured (sandbox mode)",
      fromEmail: process.env.SMTP_FROM_EMAIL || "support@omniplatform.internal",
      fromName: process.env.SMTP_FROM_NAME || "Omni Platform Support",
      totalRecentDispatched: this.recentLogs.length,
    };
  }

  public getRecentLogs(): EmailLogEntry[] {
    return [...this.recentLogs];
  }

  public async sendEmail(options: SendEmailOptions): Promise<{ success: boolean; simulated: boolean; error?: string }> {
    const fromAddress = options.from || `"${process.env.SMTP_FROM_NAME || "Omni Platform"}" <${process.env.SMTP_FROM_EMAIL || "noreply@omniplatform.internal"}>`;
    const logId = `em_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const plainText = options.text || options.html.replace(/<[^>]+>/g, " ").trim().substring(0, 160);

    if (this.isConfigured && this.transporter) {
      try {
        await this.transporter.sendMail({
          from: fromAddress,
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: options.text,
          replyTo: options.replyTo,
          bcc: options.bcc,
          attachments: options.attachments,
        });

        this.addLog({
          id: logId,
          to: options.to,
          subject: options.subject,
          from: fromAddress,
          sentAt: new Date().toISOString(),
          status: "sent",
          previewSnippet: plainText,
        });

        logger.info(`[EmailService] Email sent successfully to ${JSON.stringify(options.to)} | Subject: "${options.subject}"`);
        return { success: true, simulated: false };
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        logger.error(`[EmailService] Error sending email via SMTP to ${JSON.stringify(options.to)}:`, err);

        this.addLog({
          id: logId,
          to: options.to,
          subject: options.subject,
          from: fromAddress,
          sentAt: new Date().toISOString(),
          status: "failed",
          error: errorMsg,
          previewSnippet: plainText,
        });

        return { success: false, simulated: false, error: errorMsg };
      }
    } else {
      // Sandbox mode: log clearly for dev/test observability
      logger.info(
        `[EmailService:SANDBOX] Simulated Email Delivery:\n` +
          `  ID: ${logId}\n` +
          `  To: ${JSON.stringify(options.to)}\n` +
          `  From: ${fromAddress}\n` +
          `  Subject: ${options.subject}\n` +
          `  Body Preview: ${plainText.substring(0, 100)}...`
      );

      this.addLog({
        id: logId,
        to: options.to,
        subject: options.subject,
        from: fromAddress,
        sentAt: new Date().toISOString(),
        status: "simulated",
        previewSnippet: plainText,
      });

      return { success: true, simulated: true };
    }
  }

  private addLog(entry: EmailLogEntry): void {
    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > this.maxLogs) {
      this.recentLogs.pop();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Transactional Email Templates
  // ─────────────────────────────────────────────────────────

  public async sendTicketCreatedConfirmation(params: {
    to: string;
    userName: string;
    ticketNumber: string;
    subject: string;
    category: string;
    priority: string;
    message: string;
  }): Promise<void> {
    const { to, userName, ticketNumber, subject, category, priority, message } = params;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 24px 32px; color: #ffffff;">
          <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Omni Platform Support</h1>
          <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Helpdesk Case #${ticketNumber}</p>
        </div>
        <div style="padding: 32px; color: #334155;">
          <h2 style="margin: 0 0 16px; font-size: 18px; color: #0f172a;">Ticket Created Successfully</h2>
          <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.6;">
            Hello <strong>${userName}</strong>,<br/>
            We have received your support request. Our platform support engineering team has been notified and is reviewing your case.
          </p>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin-bottom: 24px;">
            <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
              <tr>
                <td style="padding: 4px 0; color: #64748b; width: 110px;">Ticket #:</td>
                <td style="padding: 4px 0; font-weight: 600; color: #0f172a;">${ticketNumber}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Subject:</td>
                <td style="padding: 4px 0; font-weight: 600; color: #0f172a;">${subject}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Category:</td>
                <td style="padding: 4px 0; text-transform: capitalize; color: #0f172a;">${category.replace("_", " ")}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Priority:</td>
                <td style="padding: 4px 0; text-transform: uppercase; font-weight: 700; color: ${priority === 'urgent' ? '#dc2626' : priority === 'high' ? '#d97706' : '#2563eb'};">${priority}</td>
              </tr>
            </table>
          </div>
          <div style="margin-bottom: 24px;">
            <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b;">Your Initial Message:</p>
            <div style="background-color: #f1f5f9; padding: 14px; border-radius: 6px; font-size: 13px; line-height: 1.5; color: #1e293b; white-space: pre-wrap;">${message}</div>
          </div>
          <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
            You can track this case or provide additional replies at any time in your workspace under <strong>Support & Helpdesk</strong>.
          </p>
        </div>
        <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; text-align: center; font-size: 12px; color: #94a3b8;">
          © ${new Date().getFullYear()} Omni Platform SaaS. All rights reserved. Zero-PII Protected.
        </div>
      </div>
    `;

    await this.sendEmail({
      to,
      subject: `[${ticketNumber}] Support Ticket Received: ${subject}`,
      html,
    });
  }

  public async sendTicketReplyNotification(params: {
    to: string;
    recipientName: string;
    ticketNumber: string;
    subject: string;
    senderName: string;
    isStaffReply: boolean;
    message: string;
  }): Promise<void> {
    const { to, recipientName, ticketNumber, subject, senderName, isStaffReply, message } = params;

    const badgeLabel = isStaffReply ? "Support Agent Reply" : "Customer Reply";
    const badgeColor = isStaffReply ? "#4f46e5" : "#059669";

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f172a; padding: 24px 32px; color: #ffffff; border-bottom: 3px solid ${badgeColor};">
          <div style="display: inline-block; background-color: ${badgeColor}; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; margin-bottom: 8px;">
            ${badgeLabel}
          </div>
          <h1 style="margin: 0; font-size: 18px; font-weight: 700;">Case #${ticketNumber} Update</h1>
          <p style="margin: 4px 0 0; font-size: 13px; color: #94a3b8;">${subject}</p>
        </div>
        <div style="padding: 32px; color: #334155;">
          <p style="margin: 0 0 18px; font-size: 14px;">
            Hello <strong>${recipientName}</strong>,
          </p>
          <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.6;">
            <strong>${senderName}</strong> has posted a new update to support ticket <strong>#${ticketNumber}</strong>:
          </p>
          <div style="background-color: #f8fafc; border-left: 4px solid ${badgeColor}; padding: 16px 20px; border-radius: 0 8px 8px 0; margin-bottom: 24px; font-size: 14px; line-height: 1.6; color: #0f172a; white-space: pre-wrap;">${message}</div>
          <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
            To view the full ticket timeline or respond, please visit your workspace portal.
          </p>
        </div>
        <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; text-align: center; font-size: 12px; color: #94a3b8;">
          © ${new Date().getFullYear()} Omni Platform SaaS. All rights reserved.
        </div>
      </div>
    `;

    await this.sendEmail({
      to,
      subject: `Re: [${ticketNumber}] ${subject}`,
      html,
    });
  }

  public async sendTicketResolvedNotification(params: {
    to: string;
    userName: string;
    ticketNumber: string;
    subject: string;
    resolvedByName: string;
  }): Promise<void> {
    const { to, userName, ticketNumber, subject, resolvedByName } = params;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding: 24px 32px; color: #ffffff;">
          <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Ticket Resolved</h1>
          <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Case #${ticketNumber}</p>
        </div>
        <div style="padding: 32px; color: #334155;">
          <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.6;">
            Hello <strong>${userName}</strong>,<br/>
            Your support ticket <strong>#${ticketNumber}</strong> ("${subject}") has been marked as <strong>Resolved</strong> by ${resolvedByName}.
          </p>
          <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px; color: #065f46; font-size: 13px; line-height: 1.5;">
            ✓ We are glad we could assist you! If you still require further assistance regarding this matter, you can reply directly on the ticket thread within your portal to reopen it.
          </div>
        </div>
        <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; text-align: center; font-size: 12px; color: #94a3b8;">
          © ${new Date().getFullYear()} Omni Platform SaaS. All rights reserved.
        </div>
      </div>
    `;

    await this.sendEmail({
      to,
      subject: `[Resolved] [${ticketNumber}] ${subject}`,
      html,
    });
  }

  public async sendSubscriptionReceipt(params: {
    to: string;
    tenantName: string;
    planName: string;
    invoiceNumber: string;
    amount: number;
    currency: string;
    billingCycle: string;
    periodEnd: string;
    paymentMethod: string;
    /** Tax split of `amount` (the total charged). */
    subtotal?: number;
    taxAmount?: number;
    taxRate?: number;
    taxLabel?: string | null;
    buyerTaxId?: string | null;
    sellerTaxId?: string | null;
    sellerLegalName?: string | null;
    /** The invoice PDF to attach (omitted when INVOICE_PDF_ATTACH is off). */
    pdf?: { fileName: string; content: Buffer };
    /** Copy for the accountant (INVOICE_BCC_EMAIL). */
    bcc?: string;
    /** An automatic renewal rather than a first purchase. */
    isRenewal?: boolean;
  }): Promise<{ success: boolean; simulated: boolean; error?: string }> {
    const { to, invoiceNumber, amount, currency, billingCycle, periodEnd, paymentMethod } = params;
    const { subtotal, taxAmount = 0, taxRate = 0, taxLabel, buyerTaxId, sellerTaxId, sellerLegalName } = params;
    // Names come from users: escape them before they go into HTML.
    const esc = (value: string): string =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const tenantName = esc(params.tenantName);
    const planName = esc(params.planName);
    const money = (value: number): string => `${currency} ${value.toFixed(2)}`;
    const row = (label: string, value: string, extraStyle = ""): string => `
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 8px 0; color: #64748b;">${label}</td>
                <td style="padding: 8px 0; color: #0f172a; text-align: right; ${extraStyle}">${value}</td>
              </tr>`;
    const taxRows =
      taxAmount > 0
        ? row("Subtotal:", money(subtotal ?? amount - taxAmount)) +
          row(`${esc(taxLabel || "Tax")} (${taxRate}%):`, money(taxAmount))
        : "";
    const sellerLines = [
      sellerLegalName ? `Issued by ${esc(sellerLegalName)}` : "",
      sellerTaxId ? `GSTIN ${esc(sellerTaxId)}` : "",
      buyerTaxId ? `Billed to GSTIN ${esc(buyerTaxId)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f172a; padding: 24px 32px; color: #ffffff;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Omni Platform Subscription Receipt</h1>
          </div>
          <p style="margin: 6px 0 0; font-size: 13px; color: #94a3b8;">Invoice #${invoiceNumber}</p>
        </div>
        <div style="padding: 32px; color: #334155;">
          <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.6;">
            ${params.isRenewal ? "Your subscription has renewed" : "Thank you for subscribing"}, <strong>${tenantName}</strong>!<br/>
            ${params.isRenewal ? "Your automatic renewal payment was successful." : "Your payment was received and your plan is active."}
            ${params.pdf ? "Your invoice is attached to this email as a PDF." : "You can download your invoice as a PDF from Settings, Usage and Plans."}
          </p>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 8px 0; color: #64748b;">Plan Tier:</td>
                <td style="padding: 8px 0; font-weight: 700; color: #0f172a; text-align: right;">${planName}</td>
              </tr>
              ${taxRows}
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 8px 0; color: #64748b;">Amount Paid:</td>
                <td style="padding: 8px 0; font-weight: 700; color: #059669; text-align: right; font-size: 15px;">${money(amount)}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 8px 0; color: #64748b;">Billing Cycle:</td>
                <td style="padding: 8px 0; text-transform: capitalize; color: #0f172a; text-align: right;">${billingCycle}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 8px 0; color: #64748b;">Payment Method:</td>
                <td style="padding: 8px 0; text-transform: uppercase; color: #0f172a; text-align: right;">${paymentMethod}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b;">Active Through:</td>
                <td style="padding: 8px 0; font-weight: 600; color: #4f46e5; text-align: right;">${new Date(periodEnd).toLocaleDateString()}</td>
              </tr>
            </table>
          </div>
          <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
            Your full quota limits (channels, contacts, messages, AI copilot queries) are unlocked for this period.
          </p>
          ${sellerLines ? `<p style="margin: 12px 0 0; font-size: 11px; color: #94a3b8;">${sellerLines}</p>` : ""}
        </div>
        <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; text-align: center; font-size: 12px; color: #94a3b8;">
          © ${new Date().getFullYear()} Omni Platform SaaS. All rights reserved.
        </div>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `Payment Receipt: ${planName} Subscription [${invoiceNumber}]`,
      html,
      bcc: params.bcc,
      attachments: params.pdf
        ? [{ filename: params.pdf.fileName, content: params.pdf.content, contentType: "application/pdf" }]
        : undefined,
    });
  }

  /** A credit note issued to the workspace owner (a refund, or the credit of an upgrade), with its PDF. */
  public async sendCreditNote(params: {
    to: string;
    tenantName: string;
    creditNoteNumber: string;
    invoiceNumber: string;
    appliedToInvoiceNumber: string | null;
    total: number;
    currency: string;
    reason: string;
    pdf?: { fileName: string; content: Buffer };
    bcc?: string;
  }): Promise<{ success: boolean; simulated: boolean; error?: string }> {
    const money = `${escapeHtml(params.currency)} ${params.total.toFixed(2)}`;
    const html = this.billingNoticeHtml(`Credit note ${params.creditNoteNumber}`, [
      `A credit note of <strong>${money}</strong> was issued to <strong>${escapeHtml(params.tenantName)}</strong> against invoice ${escapeHtml(params.invoiceNumber)}.`,
      params.appliedToInvoiceNumber
        ? `It was applied to invoice ${escapeHtml(params.appliedToInvoiceNumber)}, so no separate payment or refund is due for this amount.`
        : "Any refund is paid back through your original payment method.",
      `Reason: ${escapeHtml(params.reason)}`,
      params.pdf ? "The credit note is attached to this email as a PDF." : "You can download it as a PDF from Settings, Usage and Plans.",
    ]);
    return this.sendEmail({
      to: params.to,
      subject: `Credit note ${params.creditNoteNumber} (against ${params.invoiceNumber})`,
      html,
      bcc: params.bcc,
      attachments: params.pdf
        ? [{ filename: params.pdf.fileName, content: params.pdf.content, contentType: "application/pdf" }]
        : undefined,
    });
  }

  /** Shared frame for the short billing notices below. */
  private billingNoticeHtml(title: string, lines: string[]): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f172a; padding: 20px 28px; color: #ffffff;">
          <h1 style="margin: 0; font-size: 18px; font-weight: 700;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding: 24px 28px; color: #334155; font-size: 14px; line-height: 1.6;">
          ${lines.map((line) => `<p style="margin: 0 0 12px;">${line}</p>`).join("")}
        </div>
      </div>`;
  }

  /** The automatic renewal charge failed. The provider retries; access continues until the paid period ends. */
  public async sendSubscriptionPaymentFailed(params: {
    to: string;
    tenantName: string;
    planName: string;
    amount: number;
    currency: string;
    gateway: string;
    keepsAccessUntil: string | null;
  }): Promise<void> {
    const { to, amount, currency, gateway, keepsAccessUntil } = params;
    const tenantName = escapeHtml(params.tenantName);
    const planName = escapeHtml(params.planName);
    const until = keepsAccessUntil ? new Date(keepsAccessUntil).toLocaleDateString() : null;
    const html = this.billingNoticeHtml("We couldn't renew your subscription", [
      `Hi <strong>${tenantName}</strong>,`,
      `The automatic renewal of your <strong>${planName}</strong> plan (${escapeHtml(currency)} ${amount.toFixed(2)}) did not go through.`,
      gateway === "stripe"
        ? "Please update your card from Settings → Usage &amp; Plans → Manage card. We'll try the payment again."
        : "Please check your UPI / bank mandate and make sure the balance is available. The payment will be tried again.",
      until
        ? `Your plan stays active until <strong>${until}</strong>. If the payment still fails after that, the workspace moves to the Free plan.`
        : "If the payment keeps failing, the workspace will move to the Free plan.",
    ]);
    await this.sendEmail({ to, subject: `Action needed: your ${params.planName} renewal failed`, html });
  }

  /** A prepaid plan (no automatic renewal) is about to run out. */
  public async sendPlanExpiringSoon(params: {
    to: string;
    tenantName: string;
    planName: string;
    expiresAt: string;
  }): Promise<void> {
    const tenantName = escapeHtml(params.tenantName);
    const planName = escapeHtml(params.planName);
    const html = this.billingNoticeHtml("Your plan ends soon", [
      `Hi <strong>${tenantName}</strong>,`,
      `Your <strong>${planName}</strong> plan ends on <strong>${new Date(params.expiresAt).toLocaleDateString()}</strong>.`,
      "Renew it from Settings → Usage &amp; Plans to keep your limits and features. You can turn on automatic renewal there so this does not happen again.",
    ]);
    await this.sendEmail({ to: params.to, subject: `Your ${params.planName} plan ends soon`, html });
  }

  /** The plan ran out (after the grace period) and the workspace was moved to the Free plan. */
  public async sendPlanExpired(params: { to: string; tenantName: string; planName: string }): Promise<void> {
    const tenantName = escapeHtml(params.tenantName);
    const planName = escapeHtml(params.planName);
    const html = this.billingNoticeHtml("Your plan has ended", [
      `Hi <strong>${tenantName}</strong>,`,
      `Your <strong>${planName}</strong> plan ended and the workspace is now on the Free plan. Your data is safe.`,
      "You can upgrade again any time from Settings → Usage &amp; Plans.",
    ]);
    await this.sendEmail({ to: params.to, subject: `Your ${params.planName} plan has ended`, html });
  }

  public async sendPasswordResetEmail(params: {
    to: string;
    userName: string;
    resetUrl: string;
    expiresInMinutes: number;
  }): Promise<{ success: boolean; simulated: boolean; error?: string }> {
    const { to, resetUrl, expiresInMinutes } = params;
    const userName = escapeHtml(params.userName);
    const safeUrl = escapeHtml(resetUrl);

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 24px 32px; color: #ffffff;">
          <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Reset your password</h1>
          <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Omni Platform</p>
        </div>
        <div style="padding: 32px; color: #334155;">
          <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.6;">
            Hello <strong>${userName}</strong>,<br/>
            We received a request to reset the password for your Omni Platform account. Click the button below to choose a new password.
          </p>
          <div style="text-align: center; margin: 28px 0;">
            <a href="${safeUrl}" style="display: inline-block; background-color: #4f46e5; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; padding: 12px 28px; border-radius: 8px;">Reset Password</a>
          </div>
          <p style="margin: 0 0 8px; font-size: 13px; color: #64748b; line-height: 1.5;">
            This link expires in <strong>${expiresInMinutes} minutes</strong> and can be used only once.
          </p>
          <p style="margin: 0 0 20px; font-size: 12px; color: #64748b; line-height: 1.5; word-break: break-all;">
            If the button doesn't work, copy this link into your browser:<br/>
            <a href="${safeUrl}" style="color: #4f46e5;">${safeUrl}</a>
          </p>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; font-size: 12px; color: #64748b; line-height: 1.5;">
            If you didn't ask to reset your password, you can ignore this email. Your password won't change.
          </div>
        </div>
        <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; text-align: center; font-size: 12px; color: #94a3b8;">
          © ${new Date().getFullYear()} Omni Platform SaaS. All rights reserved.
        </div>
      </div>
    `;

    const text =
      `Hello ${params.userName},\n\n` +
      `We received a request to reset the password for your Omni Platform account.\n` +
      `Open this link to choose a new password:\n\n${resetUrl}\n\n` +
      `This link expires in ${expiresInMinutes} minutes and can be used only once.\n\n` +
      `If you didn't ask to reset your password, you can ignore this email. Your password won't change.`;

    return this.sendEmail({ to, subject: "Reset your Omni Platform password", html, text });
  }

  public async sendPasswordChangedEmail(params: { to: string; userName: string }): Promise<void> {
    const { to } = params;
    const userName = escapeHtml(params.userName);
    const changedAt = new Date().toUTCString();

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f172a; padding: 24px 32px; color: #ffffff; border-bottom: 3px solid #059669;">
          <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Your password was changed</h1>
          <p style="margin: 4px 0 0; font-size: 13px; color: #94a3b8;">Security notice</p>
        </div>
        <div style="padding: 32px; color: #334155;">
          <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.6;">
            Hello <strong>${userName}</strong>,<br/>
            The password for your Omni Platform account was reset on <strong>${changedAt}</strong>. For your security, all existing sessions have been logged out.
          </p>
          <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 14px; font-size: 13px; color: #991b1b; line-height: 1.5;">
            If you didn't make this change, reset your password again right away using "Forgot password?" on the login page, and contact your workspace administrator.
          </div>
        </div>
        <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 32px; text-align: center; font-size: 12px; color: #94a3b8;">
          © ${new Date().getFullYear()} Omni Platform SaaS. All rights reserved.
        </div>
      </div>
    `;

    const text =
      `Hello ${params.userName},\n\n` +
      `The password for your Omni Platform account was reset on ${changedAt}. All existing sessions have been logged out.\n\n` +
      `If you didn't make this change, reset your password again right away using "Forgot password?" on the login page, and contact your workspace administrator.`;

    await this.sendEmail({ to, subject: "Your Omni Platform password was changed", html, text });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const emailService = new EmailService();
