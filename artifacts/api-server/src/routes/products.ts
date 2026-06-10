import { Router, type IRouter } from "express";
import { getProductDetail, getProductReviews } from "../modules/menu/menu.controller.js";

const router: IRouter = Router();

router.get("/:productId", getProductDetail);
router.get("/:productId/reviews", getProductReviews);

export default router;
