import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { optionalAuthenticate } from "../../middleware/employee.js";
import * as paymentsController from "./payments.controller.js";

const router: IRouter = Router();

router.post("/", optionalAuthenticate, paymentsController.createPayment);
router.get("/:paymentId/receipt", paymentsController.getReceipt);

export default router;
