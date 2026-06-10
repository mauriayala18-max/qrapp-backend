import { Router, type IRouter } from "express";
import { optionalAuthenticate } from "../middleware/employee.js";
import { getPaymentLink, completePaymentLink } from "../modules/payments/payments.controller.js";

const router: IRouter = Router();

router.get("/:linkId", getPaymentLink);
router.post("/:linkId/complete", optionalAuthenticate, completePaymentLink);

export default router;
