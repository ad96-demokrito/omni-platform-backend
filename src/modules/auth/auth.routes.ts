import { Router } from "express";
import {
  signup,
  login,
  getProfile,
  updateProfile,
  requestPasswordReset,
  isAccountDeactivated,
  validateResetToken,
  resetPassword,
  AuthError,
} from "./auth.service";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { rateLimitByIp, hitRateLimit } from "../../middleware/rate-limit";
import { logger } from "../../utils/logger";
import { normalizeCountryCode } from "../billing/currency";

const PASSWORD_RESET_WINDOW_SECONDS =
  Number(process.env.PASSWORD_RESET_WINDOW_SECONDS) || 15 * 60;

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { tenantName, email, password, country } = req.body || {};
  if (!tenantName || !email || !password) {
    return res
      .status(400)
      .json({ error: "tenantName, email and password are required" });
  }
  // Optional: the billing country decides the currency prices are shown in.
  const billingCountry = country === undefined || country === null || country === "" ? null : normalizeCountryCode(country);
  if (country !== undefined && country !== null && country !== "" && !billingCountry) {
    return res.status(400).json({ error: "country must be a 2-letter ISO country code (for example IN or US)" });
  }
  try {
    const result = await signup({ tenantName, email, password, country: billingCountry });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AuthError)
      return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const result = await login({ email, password });
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError)
      return res.status(401).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * GET /api/auth/me
 * Returns detailed profile of the currently authenticated user.
 */
authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.auth?.userId;
    const tenantId = req.auth?.tenantId;
    if (!userId || !tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const profile = await getProfile(userId, tenantId);
    if (!profile) {
      return res.status(404).json({ error: "User profile not found" });
    }

    res.json(profile);
  } catch (err) {
    console.error("[authRouter] /me error:", err);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

/**
 * PATCH /api/auth/profile
 * Updates the user's name and/or password.
 */
authRouter.patch("/profile", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.auth?.userId;
    const tenantId = req.auth?.tenantId;
    if (!userId || !tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { name, currentPassword, newPassword } = req.body || {};
    const updated = await updateProfile({
      userId,
      tenantId,
      name,
      currentPassword,
      newPassword,
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("[authRouter] /profile error:", err);
    res.status(500).json({ error: "Failed to update user profile" });
  }
});

/**
 * POST /api/auth/forgot-password
 * Always replies 200 with the same message whether or not the email has an
 * account. The email is sent in the background so response time doesn't
 * reveal it either.
 */
authRouter.post(
  "/forgot-password",
  rateLimitByIp("forgot-password", 5, PASSWORD_RESET_WINDOW_SECONDS),
  async (req, res) => {
    const { email } = req.body || {};
    if (
      !email ||
      typeof email !== "string" ||
      !/\S+@\S+\.\S+/.test(email.trim())
    ) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const allowed = await hitRateLimit(
      `ratelimit:forgot-password:email:${normalizedEmail}`,
      3,
      PASSWORD_RESET_WINDOW_SECONDS,
    );
    if (!allowed) {
      return res
        .status(429)
        .json({ error: "Too many requests. Please try again later." });
    }

    try {
      if (await isAccountDeactivated(normalizedEmail)) {
        return res.status(403).json({
          error:
            "Your account is deactivated. Please contact your workspace administrator.",
        });
      }
    } catch (err) {
      logger.error("[authRouter] forgot-password status check error:", err);
      return res.status(500).json({ error: "Failed to process request" });
    }

    requestPasswordReset(normalizedEmail, req.ip || null).catch((err) =>
      logger.error("[authRouter] forgot-password background error:", err),
    );

    res.json({
      message:
        "If an account exists for this email, we've sent a password reset link.",
    });
  },
);

/**
 * POST /api/auth/reset-password/validate
 * Checks a reset link before showing the form. The token is sent in the body
 * (not the query string) so it never appears in request-log URLs.
 * Invalid tokens return 400, not 401, because the frontend logs out on any 401.
 */
authRouter.post(
  "/reset-password/validate",
  rateLimitByIp("reset-validate", 30, PASSWORD_RESET_WINDOW_SECONDS),
  async (req, res) => {
    const { token } = req.body || {};
    if (!token || typeof token !== "string") {
      return res
        .status(400)
        .json({ valid: false, error: "Reset token is required" });
    }
    try {
      const valid = await validateResetToken(token);
      if (!valid) {
        return res
          .status(400)
          .json({
            valid: false,
            error: "This reset link is invalid or has expired",
          });
      }
      res.json({ valid: true });
    } catch (err) {
      console.error("[authRouter] reset-password/validate error:", err);
      res.status(500).json({ error: "Failed to validate reset link" });
    }
  },
);

/**
 * POST /api/auth/reset-password
 * Sets a new password using a valid reset token. Logs out all existing sessions.
 */
authRouter.post(
  "/reset-password",
  rateLimitByIp("reset-password", 10, PASSWORD_RESET_WINDOW_SECONDS),
  async (req, res) => {
    const { token, password } = req.body || {};
    if (
      !token ||
      typeof token !== "string" ||
      !password ||
      typeof password !== "string"
    ) {
      return res.status(400).json({ error: "token and password are required" });
    }
    try {
      await resetPassword(token, password);
      res.json({
        message:
          "Your password has been reset. Please log in with your new password.",
      });
    } catch (err) {
      if (err instanceof AuthError)
        return res.status(400).json({ error: err.message });
      console.error("[authRouter] reset-password error:", err);
      res.status(500).json({ error: "Failed to reset password" });
    }
  },
);
