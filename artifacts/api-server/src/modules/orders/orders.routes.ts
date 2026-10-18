import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireEmployee, optionalAuthenticate } from "../../middleware/employee.js";
import { requireSeat, sessionFromBody, sessionFromOrder } from "../../middleware/seat.js";
import * as ordersController from "./orders.controller.js";

const router: IRouter = Router();

// A web diner has no account, so the JWT is optional here. The seat token
// (X-Seat-Token) is the credential; the service still decides whether the seat
// additionally needs its account's JWT.
router.post(
  "/",
  optionalAuthenticate,
  requireSeat({ session: sessionFromBody("session_id"), identity: "seat" }),
  ordersController.createOrder,
);
router.post("/traditional", authenticate, requireEmployee, ordersController.createTraditionalOrder);
router.post("/anticipatory", authenticate, ordersController.createAnticipatoryOrder);
router.get("/:orderId", ordersController.getOrder);
router.post("/:orderId/link", authenticate, requireEmployee, ordersController.linkOrder);
router.patch("/:orderId/items/:itemId/status", authenticate, requireEmployee, ordersController.updateItemStatus);
router.patch("/:orderId/status", authenticate, requireEmployee, ordersController.updateOrderStatus);
// Staff cancel on employee auth alone; a diner also needs their seat token.
router.post(
  "/:orderId/cancel",
  authenticate,
  requireSeat({ session: sessionFromOrder, allowStaff: true, identity: "jwt" }),
  ordersController.cancelOrder,
);

export default router;
