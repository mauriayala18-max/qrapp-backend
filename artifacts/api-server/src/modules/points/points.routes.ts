import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as pointsController from "./points.controller.js";

const router: IRouter = Router();

router.get("/balance", authenticate, pointsController.getBalance);
router.get("/history", authenticate, pointsController.getHistory);
router.post("/redeem", authenticate, pointsController.redeemPoints);

export default router;
