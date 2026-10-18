import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { optionalAuthenticate } from "../../middleware/employee.js";
import { requireSeat, sessionFromBody } from "../../middleware/seat.js";
import * as paymentsController from "./payments.controller.js";

const router: IRouter = Router();

// Staff record cash/POS on employee auth; a diner pays with their seat token.
router.post(
  "/",
  optionalAuthenticate,
  requireSeat({ session: sessionFromBody("session_id"), allowStaff: true, identity: "seat" }),
  paymentsController.createPayment,
);
router.get("/:paymentId/receipt", paymentsController.getReceipt);

export default router;
