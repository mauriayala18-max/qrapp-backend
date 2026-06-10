import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireEmployee, optionalAuthenticate } from "../../middleware/employee.js";
import * as sessionsController from "./sessions.controller.js";
import * as waiterCallsController from "../waiter-calls/waiter-calls.controller.js";
import * as paymentsController from "../payments/payments.controller.js";

const router: IRouter = Router();

router.post("/join", optionalAuthenticate, sessionsController.joinSession);
router.post("/scan", optionalAuthenticate, sessionsController.scanAndJoin);
router.get("/:sessionId", authenticate, sessionsController.getSession);
router.get("/:sessionId/participants", sessionsController.getParticipants);
router.post("/:sessionId/close", authenticate, requireEmployee, sessionsController.closeSession);
router.post("/:sessionId/call-waiter", optionalAuthenticate, waiterCallsController.callWaiter);
router.get("/:sessionId/payments", paymentsController.getSessionPayments);
router.post("/:sessionId/split", authenticate, paymentsController.createSplit);
router.post("/:sessionId/payment-link", authenticate, paymentsController.createPaymentLink);
router.post("/:sessionId/invoice", authenticate, paymentsController.createInvoice);
router.get("/:sessionId/invoice", paymentsController.getSessionInvoices);

export default router;
