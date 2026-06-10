import { Router, type IRouter } from "express";
import { getProductDetail, getProductReviews as getMenuProductReviews } from "../modules/menu/menu.controller.js";
import { getProductRatings, getProductReviews } from "../modules/ratings/ratings.controller.js";

const router: IRouter = Router();

router.get("/:productId", getProductDetail);
router.get("/:productId/reviews", getMenuProductReviews);
router.get("/:productId/ratings", getProductRatings);
router.get("/:productId/reviews/all", getProductReviews);

export default router;
