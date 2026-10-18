import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireEmployee, optionalAuthenticate } from "../../middleware/employee.js";
import * as sessionsController from "./sessions.controller.js";
import * as expulsionsController from "../expulsions/expulsions.controller.js";
import * as waiterCallsController from "../waiter-calls/waiter-calls.controller.js";
import * as paymentsController from "../payments/payments.controller.js";
import { requireSeat, sessionFromParam } from "../../middleware/seat.js";

const seatFromParam = sessionFromParam("sessionId");

const router: IRouter = Router();

router.post("/join", optionalAuthenticate, sessionsController.joinSession);
router.post("/scan", optionalAuthenticate, sessionsController.scanAndJoin);
// An active web participant proves membership with their own participant_id
// (no account exists for them to log into); everyone else needs their JWT.
router.get("/:sessionId", optionalAuthenticate, sessionsController.getSession);
router.get("/:sessionId/participants", authenticate, sessionsController.getParticipants);
router.post("/:sessionId/close", authenticate, requireEmployee, sessionsController.closeSession);
router.post(
  "/:sessionId/call-waiter",
  optionalAuthenticate,
  requireSeat({ session: seatFromParam, identity: "seat" }),
  waiterCallsController.callWaiter,
);

// Expulsion and sealing. Who may call each one is decided inside the service
// against the session's branch and participant list, never from the request.
router.post("/:sessionId/expulsions/staff", authenticate, expulsionsController.staffExpel);
router.post(
  "/:sessionId/expulsions",
  authenticate,
  requireSeat({ session: seatFromParam, identity: "jwt" }),
  expulsionsController.proposeExpulsion,
);
router.post(
  "/:sessionId/lock",
  authenticate,
  requireSeat({ session: seatFromParam, allowStaff: true, identity: "jwt" }),
  sessionsController.lockSession,
);
router.post("/:sessionId/unlock", authenticate, sessionsController.unlockSession);

router.get("/:sessionId/payments", paymentsController.getSessionPayments);
router.post(
  "/:sessionId/split",
  authenticate,
  requireSeat({ session: seatFromParam, allowStaff: true, identity: "jwt" }),
  paymentsController.createSplit,
);
router.post(
  "/:sessionId/payment-link",
  authenticate,
  requireSeat({ session: seatFromParam, identity: "jwt" }),
  paymentsController.createPaymentLink,
);
router.post("/:sessionId/invoice", authenticate, requireEmployee, paymentsController.createInvoice);
router.get("/:sessionId/invoice", paymentsController.getSessionInvoices);

export default router;
