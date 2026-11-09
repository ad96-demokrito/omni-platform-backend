import { Router, Response } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { httpError, isUuid } from "../../utils/http-error";
import {
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  setTeamMembers,
  getTeamSettings,
  updateTeamSettings,
} from "./teams.service";

export const teamsRouter = Router();
teamsRouter.use(requireAuth);

const actorOf = (req: AuthedRequest) => ({
  userId: req.auth!.userId,
  email: req.auth!.email,
  ipAddress: req.ip,
});

function teamIdOf(req: AuthedRequest): string {
  if (!isUuid(req.params.id)) throw httpError(400, "Invalid team id");
  return req.params.id;
}

/**
 * Workspace routing settings. Declared before the `/:id` routes so "settings" is not read as a team id.
 * Anyone signed in can read it (the flow builder shows the current mode); only owners/admins change it.
 */
teamsRouter.get(
  "/settings",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await getTeamSettings(req.auth!.tenantId));
  })
);

teamsRouter.patch(
  "/settings",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await updateTeamSettings(req.auth!.tenantId, actorOf(req), req.body || {}));
  })
);

/** Any signed-in user can list teams (the inbox needs them for its assign menus). */
teamsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await listTeams(req.auth!.tenantId));
  })
);

teamsRouter.post(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { name, description } = req.body || {};
    res.status(201).json(await createTeam(req.auth!.tenantId, actorOf(req), { name, description }));
  })
);

teamsRouter.patch(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { name, description } = req.body || {};
    res.json(
      await updateTeam(req.auth!.tenantId, actorOf(req), teamIdOf(req), { name, description })
    );
  })
);

teamsRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    await deleteTeam(req.auth!.tenantId, actorOf(req), teamIdOf(req));
    res.status(204).send();
  })
);

teamsRouter.put(
  "/:id/members",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { userIds } = req.body || {};
    res.json(await setTeamMembers(req.auth!.tenantId, actorOf(req), teamIdOf(req), userIds));
  })
);
