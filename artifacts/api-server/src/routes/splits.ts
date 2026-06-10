import { Router, type IRouter } from "express";
import { authenticate } from "../middleware/auth.js";
import { getSplit, claimSplitItems } from "../modules/payments/payments.controller.js";

const router: IRouter = Router();

router.get("/:splitId", getSplit);
router.post("/:splitId/claim", authenticate, claimSplitItems);

export default router;
