import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as expulsionsController from "./expulsions.controller.js";

const router: IRouter = Router();

// Readmission is staff-only and is checked against the branch that owns the
// record, inside the service - the route just proves who is calling.
router.post("/records/:recordId/readmit", authenticate, expulsionsController.readmit);

router.post("/:proposalId/vote", authenticate, expulsionsController.voteExpulsion);
router.post("/:proposalId/cancel", authenticate, expulsionsController.cancelProposal);

export default router;
