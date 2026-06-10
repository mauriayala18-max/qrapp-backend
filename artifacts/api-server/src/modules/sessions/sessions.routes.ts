import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireEmployee, optionalAuthenticate } from "../../middleware/employee.js";
import * as sessionsController from "./sessions.controller.js";
import * as waiterCallsController from "../waiter-calls/waiter-calls.controller.js";

const router: IRouter = Router();

router.post("/join", optionalAuthenticate, sessionsController.joinSession);
router.post("/scan", optionalAuthenticate, sessionsController.scanAndJoin);
router.get("/:sessionId", authenticate, sessionsController.getSession);
router.get("/:sessionId/participants", sessionsController.getParticipants);
router.post("/:sessionId/close", authenticate, requireEmployee, sessionsController.closeSession);
router.post("/:sessionId/call-waiter", optionalAuthenticate, waiterCallsController.callWaiter);

export default router;
