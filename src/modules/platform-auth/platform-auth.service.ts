import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { queryOne, query } from "../../db/pool";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.PLATFORM_JWT_EXPIRES_IN || "1d"; // Shorter 24h expiry for high-privilege staff

export type PlatformRole = "super_admin" | "platform_dev" | "platform_tester" | "support_agent" | "finance";

export interface PlatformTokenPayload {
  platformUserId: string;
  email: string;
  name: string;
  role: PlatformRole;
  permissions: string[];
  isPlatformUser: true; // Explicit discriminator
}

export interface PlatformUserProfile {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  status: "active" | "suspended" | "deactivated";
  permissions: string[];
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export class PlatformAuthError extends Error {
  public statusCode: number;
  public status: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = "PlatformAuthError";
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

export async function loginPlatformStaff(params: {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{
  token: string;
  user: PlatformUserProfile;
}> {
  const { email, password, ipAddress, userAgent } = params;

  const staff = await queryOne<{
    id: string;
    email: string;
    password_hash: string;
    name: string;
    role: PlatformRole;
    status: "active" | "suspended" | "deactivated";
    permissions: any;
    mfa_enabled: boolean;
    last_login_at: string | null;
    created_at: string;
  }>(
    "SELECT id, email, password_hash, name, role, status, permissions, mfa_enabled, last_login_at, created_at FROM platform_users WHERE lower(email) = lower($1)",
    [email]
  );

  if (!staff) {
    throw new PlatformAuthError("Invalid platform credentials", 401);
  }

  if (staff.status !== "active") {
    throw new PlatformAuthError(`Platform staff account is ${staff.status}. Access denied.`, 403);
  }

  const valid = await bcrypt.compare(password, staff.password_hash);
  if (!valid) {
    throw new PlatformAuthError("Invalid platform credentials", 401);
  }

  // Record login timestamp
  await queryOne("UPDATE platform_users SET last_login_at = now(), updated_at = now() WHERE id = $1", [staff.id]);

  const permissions = Array.isArray(staff.permissions) ? staff.permissions : [];

  // Log to platform audit trail
  await query(
    `INSERT INTO platform_audit_logs (platform_user_id, platform_user_email, platform_user_role, action, target_type, target_id, details, ip_address, user_agent)
     VALUES ($1::uuid, $2, $3, 'staff.login', 'platform_user', $1::text, '{"status": "success"}'::jsonb, $4, $5)`,
    [staff.id, staff.email, staff.role, ipAddress || null, userAgent || null]
  ).catch((e) => console.error("Failed to log platform login audit:", e));

  const payload: PlatformTokenPayload = {
    platformUserId: staff.id,
    email: staff.email,
    name: staff.name,
    role: staff.role,
    permissions,
    isPlatformUser: true,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);

  return {
    token,
    user: {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: staff.role,
      status: staff.status,
      permissions,
      mfaEnabled: staff.mfa_enabled,
      lastLoginAt: staff.last_login_at,
      createdAt: staff.created_at,
    },
  };
}

export async function getPlatformStaffProfile(platformUserId: string): Promise<PlatformUserProfile | null> {
  const staff = await queryOne<{
    id: string;
    email: string;
    name: string;
    role: PlatformRole;
    status: "active" | "suspended" | "deactivated";
    permissions: any;
    mfa_enabled: boolean;
    last_login_at: string | null;
    created_at: string;
  }>(
    "SELECT id, email, name, role, status, permissions, mfa_enabled, last_login_at, created_at FROM platform_users WHERE id = $1",
    [platformUserId]
  );

  if (!staff) return null;

  return {
    id: staff.id,
    email: staff.email,
    name: staff.name,
    role: staff.role,
    status: staff.status,
    permissions: Array.isArray(staff.permissions) ? staff.permissions : [],
    mfaEnabled: staff.mfa_enabled,
    lastLoginAt: staff.last_login_at,
    createdAt: staff.created_at,
  };
}

export async function updatePlatformStaffProfile(params: {
  platformUserId: string;
  name?: string;
  currentPassword?: string;
  newPassword?: string;
}): Promise<PlatformUserProfile> {
  const { platformUserId, name, currentPassword, newPassword } = params;

  const staff = await queryOne<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM platform_users WHERE id = $1",
    [platformUserId]
  );

  if (!staff) throw new PlatformAuthError("Platform staff member not found", 404);

  if (newPassword) {
    if (!currentPassword) {
      throw new PlatformAuthError("Current password is required to change platform password", 400);
    }
    const valid = await bcrypt.compare(currentPassword, staff.password_hash);
    if (!valid) {
      throw new PlatformAuthError("Current password is incorrect", 400);
    }
    if (newPassword.length < 10) {
      throw new PlatformAuthError("Platform passwords must be at least 10 characters long", 400);
    }
    const newHash = await bcrypt.hash(newPassword, 12);
    await queryOne(
      "UPDATE platform_users SET password_hash = $1, updated_at = now() WHERE id = $2",
      [newHash, platformUserId]
    );
  }

  if (name !== undefined && name.trim()) {
    await queryOne(
      "UPDATE platform_users SET name = $1, updated_at = now() WHERE id = $2",
      [name.trim(), platformUserId]
    );
  }

  const updated = await getPlatformStaffProfile(platformUserId);
  if (!updated) throw new PlatformAuthError("Failed to load updated platform profile", 500);
  return updated;
}

export function verifyPlatformToken(token: string): PlatformTokenPayload {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded?.isPlatformUser || !decoded?.platformUserId || !decoded?.role) {
      throw new PlatformAuthError("Invalid platform token claims", 401);
    }
    return decoded as PlatformTokenPayload;
  } catch (err: any) {
    if (err instanceof PlatformAuthError) throw err;
    throw new PlatformAuthError("Invalid or expired platform token", 401);
  }
}
