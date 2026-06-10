import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as promotionsController from "./promotions.controller.js";

const router: IRouter = Router();

router.post("/:promotionId/apply", authenticate, promotionsController.applyPromotion);

export default router;
