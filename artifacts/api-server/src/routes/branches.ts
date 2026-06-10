import { Router, type IRouter } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireEmployee } from "../middleware/employee.js";
import { getActiveOrders } from "../modules/orders/orders.controller.js";
import { getBranchWaiterCalls } from "../modules/waiter-calls/waiter-calls.controller.js";

const router: IRouter = Router();

router.get("/:branchId/orders/active", authenticate, requireEmployee, getActiveOrders);
router.get("/:branchId/waiter-calls", authenticate, requireEmployee, getBranchWaiterCalls);

export default router;
