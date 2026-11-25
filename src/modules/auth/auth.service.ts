import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { queryOne, withTransaction } from "../../db/pool";
import { emailService } from "../email/email.service";
import { logger } from "../../utils/logger";
import { currencyForCountry } from "../billing/currency";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export interface AuthTokenPayload {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

export interface UserProfile {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  tenantName: string;
  tenantPlan: string;
}

export class AuthError extends Error {}

/**
 * Signup creates a brand new tenant plus its first user (the "owner").
 * Every other user is created later via an invite flow scoped to an
 * existing tenant_id (not implemented in this pass).
 */
export async function signup(params: {
  tenantName: string;
  email: string;
  password: string;
  /** ISO country code; decides the billing currency (IN -> INR, otherwise USD). */
  country?: string | null;
}): Promise<{
  token: string;
  tenantId: string;
  userId: string;
  role: string;
  email: string;
}> {
  const { tenantName, email, password, country } = params;
  const billingCountry = country ?? null;

  const existing = await queryOne(
    "SELECT id FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  if (existing) {
    throw new AuthError("An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { tenantId, userId } = await withTransaction(async (client) => {
    const tenantResult = await client.query(
      "INSERT INTO tenants (name, billing_country, billing_currency) VALUES ($1, $2, $3) RETURNING id",
      [tenantName, billingCountry, currencyForCountry(billingCountry)],
    );
    const tenantId = tenantResult.rows[0].id as string;

    // A new workspace starts with the Free plan's advertised limits. (The column defaults are older, much
    // larger numbers; without this a "Free" workspace would be allowed far more than the plan page says.)
    await client.query(
      `UPDATE tenants t
       SET max_channels = p.max_channels, max_contacts = p.max_contacts,
           max_monthly_messages = p.max_monthly_messages, max_monthly_ai_queries = p.max_monthly_ai_queries
       FROM platform_plans p
       WHERE t.id = $1 AND p.id = 'free'`,
      [tenantId]
    );

    const userResult = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, status)
       VALUES ($1, $2, $3, 'owner', 'active') RETURNING id`,
      [tenantId, email, passwordHash],
    );
    const userId = userResult.rows[0].id as string;

    return { tenantId, userId };
  });

  const token = signToken({ userId, tenantId, role: "owner", email });
  return { token, tenantId, userId, role: "owner", email };
}

export async function login(params: {
  email: string;
  password: string;
}): Promise<{
  token: string;
  tenantId: string;
  userId: string;
  role: string;
  email: string;
}> {
  const { email, password } = params;

  const user = await queryOne<{
    id: string;
    tenant_id: string;
    email: string;
    password_hash: string;
    role: string;
    status: string;
  }>(
    "SELECT id, tenant_id, email, password_hash, role, status FROM users WHERE lower(email) = lower($1)",
    [email],
  );

  if (!user) throw new AuthError("Invalid email or password");
  if (user.status === "deactivated")
    throw new AuthError(
      "Account has been deactivated. Please contact your workspace administrator.",
    );

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new AuthError("Invalid email or password");

  // Update last login timestamp asynchronously
  queryOne("UPDATE users SET last_login_at = now() WHERE id = $1", [
    user.id,
  ]).catch(() => {});

  const token = signToken({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    email: user.email,
  });
  return {
    token,
    tenantId: user.tenant_id,
    userId: user.id,
    role: user.role,
    email: user.email,
  };
}

export async function getProfile(
  userId: string,
  tenantId: string,
): Promise<UserProfile | null> {
  const row = await queryOne<{
    id: string;
    tenant_id: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    last_login_at: string | null;
    created_at: string;
    tenant_name: string;
    tenant_plan: string;
  }>(
    `SELECT
       u.id,
       u.tenant_id,
       u.email,
       u.name,
       u.role,
       u.status,
       u.last_login_at,
       u.created_at,
       t.name AS tenant_name,
       t.plan AS tenant_plan
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1 AND u.tenant_id = $2`,
    [userId, tenantId],
  );

  if (!row) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    tenantName: row.tenant_name,
    tenantPlan: row.tenant_plan,
  };
}

export async function updateProfile(params: {
  userId: string;
  tenantId: string;
  name?: string;
  currentPassword?: string;
  newPassword?: string;
}): Promise<UserProfile> {
  const { userId, tenantId, name, currentPassword, newPassword } = params;

  const user = await queryOne<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE id = $1 AND tenant_id = $2",
    [userId, tenantId],
  );

  if (!user) throw new AuthError("User not found");

  if (newPassword) {
    if (!currentPassword) {
      throw new AuthError(
        "Current password is required to change your password",
      );
    }
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      throw new AuthError("Current password is incorrect");
    }
    if (newPassword.length < 6) {
      throw new AuthError("New password must be at least 6 characters");
    }
    const newHash = await bcrypt.hash(newPassword, 12);
    await queryOne(
      "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3",
      [newHash, userId, tenantId],
    );
  }

  if (name !== undefined) {
    await queryOne(
      "UPDATE users SET name = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3",
      [name.trim() || null, userId, tenantId],
    );
  }

  const updated = await getProfile(userId, tenantId);
  if (!updated) throw new AuthError("Failed to load updated profile");
  return updated;
}

// ─────────────────────────────────────────────────────────
// Forgot / reset password
// ─────────────────────────────────────────────────────────

const PASSWORD_RESET_TOKEN_TTL_MINUTES =
  Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES) || 30;
const MIN_PASSWORD_RESET_LENGTH =
  Number(process.env.MIN_PASSWORD_RESET_LENGTH) || 8;

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function isAccountDeactivated(email: string): Promise<boolean> {
  const user = await queryOne<{ status: string }>(
    "SELECT status FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  return user?.status === "deactivated";
}

/**
 * Issues a single-use reset link for the account with this email, if one
 * exists. Callers must reply the same way whether or not it does (the
 * route runs this in the background), so nothing here throws for an
 * unknown email.
 */
export async function requestPasswordReset(
  email: string,
  ip: string | null,
): Promise<void> {
  const user = await queryOne<{
    id: string;
    email: string;
    name: string | null;
    status: string;
  }>(
    "SELECT id, email, name, status FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  if (!user || user.status === "deactivated") return;

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(token);

  await withTransaction(async (client) => {
    // A new request cancels any older links that haven't been used yet
    await client.query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [user.id],
    );
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, request_ip)
       VALUES ($1, $2, now() + make_interval(mins => $3), $4)`,
      [user.id, tokenHash, PASSWORD_RESET_TOKEN_TTL_MINUTES, ip],
    );
  });

  const frontendUrl = (
    process.env.FRONTEND_URL || "http://localhost:4000"
  ).replace(/\/+$/, "");
  const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

  const result = await emailService.sendPasswordResetEmail({
    to: user.email,
    userName: user.name || user.email,
    resetUrl,
    expiresInMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
  });

  // Dev fallback: without SMTP the email is only simulated, so print the link to test locally
  if (result.simulated && process.env.NODE_ENV !== "production") {
    logger.info(
      `[auth] Password reset link for ${user.email} (SMTP not configured): ${resetUrl}`,
    );
  }
}

/** True when the token exists, hasn't been used, hasn't expired and belongs to an active account. */
export async function validateResetToken(token: string): Promise<boolean> {
  const row = await queryOne(
    `SELECT prt.id
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = $1
        AND prt.used_at IS NULL
        AND prt.expires_at > now()
        AND u.status <> 'deactivated'`,
    [hashResetToken(token)],
  );
  return !!row;
}

export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_RESET_LENGTH) {
    throw new AuthError(
      `Password must be at least ${MIN_PASSWORD_RESET_LENGTH} characters`,
    );
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  const user = await withTransaction(async (client) => {
    // FOR UPDATE so two submissions of the same link can't both succeed
    const tokenResult = await client.query(
      `SELECT prt.id, prt.user_id, u.email, u.name
         FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
        WHERE prt.token_hash = $1
          AND prt.used_at IS NULL
          AND prt.expires_at > now()
          AND u.status <> 'deactivated'
        FOR UPDATE OF prt`,
      [hashResetToken(token)],
    );
    const row = tokenResult.rows[0] as
      | { id: string; user_id: string; email: string; name: string | null }
      | undefined;
    if (!row) throw new AuthError("This reset link is invalid or has expired");

    await client.query(
      "UPDATE users SET password_hash = $1, password_changed_at = now(), updated_at = now() WHERE id = $2",
      [passwordHash, row.user_id],
    );
    await client.query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE id = $1",
      [row.id],
    );
    await client.query(
      "DELETE FROM password_reset_tokens WHERE user_id = $1 AND id <> $2",
      [row.user_id, row.id],
    );

    return row;
  });

  emailService
    .sendPasswordChangedEmail({
      to: user.email,
      userName: user.name || user.email,
    })
    .catch((err) =>
      logger.error("[auth] Failed to send password changed email:", err),
    );
}

function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}
