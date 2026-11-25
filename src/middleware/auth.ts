import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../modules/auth/auth.service";
import { ApiKeysService } from "../modules/api-keys/api-keys.service";
import { queryOne } from "../db/pool";
import { apiKeyFeatureBlock, suspendedWorkspaceBlock } from "../modules/billing/plan-limits.service";

export interface AuthedRequest extends Request {
  auth?: {
    userId: string;
    tenantId: string;
    role: string;
    email?: string;
    apiKeyId?: string;
    scopes?: string[];
  };
}

/**
 * Every tenant-scoped route uses this. It supports:
 * 1. User JWT tokens (Bearer eyJ...)
 * 2. Developer API keys (Bearer omni_live_...)
 *
 * It never trusts a tenantId from request body/query — it always comes from
 * the verified authentication token, guaranteeing cross-tenant isolation.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length).trim();
  } else if (typeof req.query.token === "string" && req.query.token && req.query.token !== "undefined" && req.query.token !== "null") {
    token = req.query.token.trim();
  }

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  // 1. Check if token is a developer API Key
  if (token.startsWith("omni_live_")) {
    try {
      const apiKey = await ApiKeysService.validateKey(token);
      if (!apiKey) {
        return res.status(401).json({ error: "Invalid, expired, or inactive API key" });
      }

      req.auth = {
        userId: `apikey:${apiKey.id}`,
        tenantId: apiKey.tenantId,
        role: "admin", // API Keys run with admin-level programmatic capabilities
        apiKeyId: apiKey.id,
        scopes: apiKey.scopes,
      };
    } catch (err) {
      return res.status(401).json({ error: "Failed to authenticate API key" });
    }

    // The plan decides whether API keys work at all, and a suspended workspace can only read.
    const keyBlocked =
      (await apiKeyFeatureBlock(req.auth!.tenantId)) ??
      (await suspendedWorkspaceBlock(req.auth!.tenantId, req.method, req.baseUrl));
    return keyBlocked ? next(keyBlocked) : next();
  }

  // 2. Validate standard JWT token
  try {
    const payload = verifyToken(token);
    if (!payload?.userId || !payload?.tenantId) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    // Validate that the user and tenant exist in the database.
    const user = await loadAuthUser(payload.userId, payload.tenantId);

    if (!user) {
      return res.status(401).json({ error: "User or tenant no longer exists. Please log in or sign up again." });
    }

    if (user.status === "deactivated") {
      return res.status(403).json({ error: "Account has been deactivated. Please contact your workspace owner." });
    }

    // A password reset logs out every session issued before it (iat is in whole seconds)
    const issuedAt = (payload as { iat?: number }).iat;
    if (user.password_changed_at && issuedAt !== undefined) {
      const changedAtSeconds = Math.floor(new Date(user.password_changed_at).getTime() / 1000);
      if (issuedAt < changedAtSeconds) {
        return res.status(401).json({ error: "Session expired, please log in again" });
      }
    }

    req.auth = {
      userId: user.id,
      email: user.email,
      tenantId: user.tenant_id,
      role: user.role,
    };
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // A suspended workspace can read but not change anything (billing, sign-in and support stay open).
  const blocked = await suspendedWorkspaceBlock(req.auth!.tenantId, req.method, req.baseUrl);
  return blocked ? next(blocked) : next();
}

type AuthUserRow = {
  id: string;
  email?: string;
  tenant_id: string;
  role: string;
  status: string;
  password_changed_at?: Date | string | null;
};

// Flips to false if migration 016 (users.password_changed_at) hasn't been applied yet,
// so auth keeps working on an old schema instead of failing every request.
let hasPasswordChangedAtColumn = true;

async function loadAuthUser(userId: string, tenantId: string): Promise<AuthUserRow | null> {
  if (hasPasswordChangedAtColumn) {
    try {
      return await queryOne<AuthUserRow>(
        "SELECT id, email, tenant_id, role, status, password_changed_at FROM users WHERE id = $1 AND tenant_id = $2",
        [userId, tenantId]
      );
    } catch (err: any) {
      if (err?.code !== "42703") throw err; // 42703 = undefined_column
      hasPasswordChangedAtColumn = false;
    }
  }
  return queryOne<AuthUserRow>(
    "SELECT id, email, tenant_id, role, status FROM users WHERE id = $1 AND tenant_id = $2",
    [userId, tenantId]
  );
}

export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
