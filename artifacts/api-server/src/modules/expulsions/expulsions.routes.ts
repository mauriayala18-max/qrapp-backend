import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireSeat, sessionFromProposal } from "../../middleware/seat.js";
import * as expulsionsController from "./expulsions.controller.js";

const seatForProposal = requireSeat({ session: sessionFromProposal, identity: "jwt" });

const router: IRouter = Router();

// Readmission is staff-only and is checked against the branch that owns the
// record, inside the service - the route just proves who is calling.
router.post("/records/:recordId/readmit", authenticate, expulsionsController.readmit);

router.post("/:proposalId/vote", authenticate, seatForProposal, expulsionsController.voteExpulsion);
router.post("/:proposalId/cancel", authenticate, seatForProposal, expulsionsController.cancelProposal);

export default router;
