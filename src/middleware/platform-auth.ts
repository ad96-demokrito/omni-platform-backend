import { Request, Response, NextFunction } from "express";
import { verifyPlatformToken, PlatformRole, PlatformTokenPayload } from "../modules/platform-auth/platform-auth.service";
import { queryOne, query } from "../db/pool";

/**
 * A `finance` login (the accountant) is read-only and sees money documents only: the payments ledger, invoice
 * PDFs and the monthly GST package. Everything else answers 403, whatever role guard a route has or lacks, so a
 * route added later without a guard cannot leak to this role.
 */
const FINANCE_ALLOWED: ReadonlyArray<{ method: string; basePath: string }> = [
  { method: "GET", basePath: "/api/platform/payments" },
  { method: "GET", basePath: "/api/platform/auth" },
  { method: "PUT", basePath: "/api/platform/auth" }, // own profile / password
];

export function financeMayAccess(method: string, baseUrl: string): boolean {
  return FINANCE_ALLOWED.some((rule) => rule.method === method.toUpperCase() && baseUrl === rule.basePath);
}

export interface PlatformAuthedRequest extends Request {
  platformUser?: {
    id: string;
    email: string;
    name: string;
    role: PlatformRole;
    permissions: string[];
  };
}

/**
 * Platform Authentication Middleware.
 * Strictly verifies platform staff JWT tokens and validates that the staff
 * member exists and is active in the `platform_users` table.
 *
 * Tenant user tokens will be strictly rejected here.
 */
export async function requirePlatformAuth(req: PlatformAuthedRequest, res: Response, next: NextFunction) {
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length).trim();
  }

  if (!token) {
    return res.status(401).json({ error: "Platform authentication required: Missing bearer token" });
  }

  try {
    const payload: PlatformTokenPayload = verifyPlatformToken(token);

    if (!payload.isPlatformUser || !payload.platformUserId) {
      return res.status(401).json({ error: "Invalid platform authentication token" });
    }

    // Verify against DB to ensure staff is active and not revoked/suspended
    const staff = await queryOne<{
      id: string;
      email: string;
      name: string;
      role: PlatformRole;
      status: string;
      permissions: any;
    }>("SELECT id, email, name, role, status, permissions FROM platform_users WHERE id = $1", [
      payload.platformUserId,
    ]);

    if (!staff) {
      return res.status(401).json({ error: "Platform staff account no longer exists." });
    }

    if (staff.status !== "active") {
      return res.status(403).json({ error: `Platform staff account is ${staff.status}. Access denied.` });
    }

    req.platformUser = {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: staff.role,
      permissions: Array.isArray(staff.permissions) ? staff.permissions : [],
    };

    if (staff.role === "finance" && !financeMayAccess(req.method, req.baseUrl)) {
      return res.status(403).json({ error: "Finance accounts can only view payments and download invoices." });
    }

    next();
  } catch (err: any) {
    return res.status(401).json({ error: "Invalid or expired platform token" });
  }
}

/**
 * Restricts platform routes to specific platform roles.
 * e.g., requirePlatformRole('super_admin') or requirePlatformRole('super_admin', 'platform_dev')
 */
export function requirePlatformRole(...allowedRoles: PlatformRole[]) {
  return (req: PlatformAuthedRequest, res: Response, next: NextFunction) => {
    if (!req.platformUser) {
      return res.status(401).json({ error: "Platform authentication required" });
    }

    if (!allowedRoles.includes(req.platformUser.role)) {
      return res.status(403).json({
        error: `Insufficient platform permissions. Required one of: [${allowedRoles.join(", ")}], but you have role '${req.platformUser.role}'.`,
      });
    }

    next();
  };
}

/**
 * Utility helper to record platform actions to `platform_audit_logs`.
 */
export async function logPlatformAudit(params: {
  platformUser: { id: string; email: string; role: string };
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, any>;
  req?: Request;
}) {
  const { platformUser, action, targetType, targetId, details, req } = params;
  const ipAddress = req?.headers["x-forwarded-for"] || req?.socket.remoteAddress;
  const userAgent = req?.headers["user-agent"];

  try {
    await query(
      `INSERT INTO platform_audit_logs (
        platform_user_id, platform_user_email, platform_user_role,
        action, target_type, target_id, details, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        platformUser.id,
        platformUser.email,
        platformUser.role,
        action,
        targetType,
        targetId || null,
        JSON.stringify(details || {}),
        ipAddress ? String(ipAddress).slice(0, 100) : null,
        userAgent ? String(userAgent).slice(0, 255) : null,
      ]
    );
  } catch (err) {
    console.error("[PlatformAuditLog] Failed to record audit log:", err);
  }
}
