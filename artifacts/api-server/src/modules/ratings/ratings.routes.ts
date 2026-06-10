import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as ratingsController from "./ratings.controller.js";

const router: IRouter = Router();

router.post("/dish", authenticate, ratingsController.createDishRating);
router.post("/dish/:ratingId/review", authenticate, ratingsController.createDishReview);
router.post("/restaurant", authenticate, ratingsController.createRestaurantRating);

export default router;
