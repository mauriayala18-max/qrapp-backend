import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireEmployee } from "../../middleware/employee.js";
import * as waiterCallsController from "./waiter-calls.controller.js";

const router: IRouter = Router();

router.patch("/:callId", authenticate, requireEmployee, waiterCallsController.updateWaiterCall);

export default router;
