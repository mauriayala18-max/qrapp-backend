import { Router, type IRouter } from "express";
import { authenticate } from "../middleware/auth.js";
import { getMyCoupons, applyCoupon } from "../modules/promotions/promotions.controller.js";

const router: IRouter = Router();

router.get("/mine", authenticate, getMyCoupons);
router.post("/:couponId/apply", authenticate, applyCoupon);

export default router;
