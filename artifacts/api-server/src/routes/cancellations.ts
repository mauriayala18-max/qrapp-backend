import { Router, type IRouter } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireEmployee } from "../middleware/employee.js";
import { handleCancellation } from "../modules/orders/orders.controller.js";

const router: IRouter = Router();

router.patch("/:requestId", authenticate, requireEmployee, handleCancellation);

export default router;
