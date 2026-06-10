import { Router, type IRouter } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireEmployee } from "../middleware/employee.js";
import {
  createProduct,
  updateProduct,
  toggleProductAvailability,
  deleteProduct,
  createCategory,
  updateCategory,
  getChangeLog,
} from "../modules/menu/menu.controller.js";
import {
  getBranchReservations,
  updateReservation,
} from "../modules/reservations/reservations.controller.js";
import {
  createPromotion,
  updatePromotion,
  deletePromotion,
  createCoupon,
  getPromotionStats,
} from "../modules/promotions/promotions.controller.js";
import {
  respondToReview,
  updateReviewStatus,
  getBranchReviews,
} from "../modules/ratings/ratings.controller.js";

const router: IRouter = Router();

router.post("/branches/:branchId/products", authenticate, requireEmployee, createProduct);
router.patch("/products/:productId", authenticate, requireEmployee, updateProduct);
router.patch("/products/:productId/availability", authenticate, requireEmployee, toggleProductAvailability);
router.delete("/products/:productId", authenticate, requireEmployee, deleteProduct);
router.post("/branches/:branchId/categories", authenticate, requireEmployee, createCategory);
router.patch("/categories/:categoryId", authenticate, requireEmployee, updateCategory);
router.get("/branches/:branchId/menu/changelog", authenticate, requireEmployee, getChangeLog);

router.get("/branches/:branchId/reservations", authenticate, requireEmployee, getBranchReservations);
router.patch("/reservations/:reservationId", authenticate, requireEmployee, updateReservation);

router.post("/branches/:branchId/promotions", authenticate, requireEmployee, createPromotion);
router.patch("/promotions/:promotionId", authenticate, requireEmployee, updatePromotion);
router.delete("/promotions/:promotionId", authenticate, requireEmployee, deletePromotion);
router.post("/branches/:branchId/coupons", authenticate, requireEmployee, createCoupon);
router.get("/branches/:branchId/promotions/stats", authenticate, requireEmployee, getPromotionStats);

router.post("/reviews/:reviewId/respond", authenticate, requireEmployee, respondToReview);
router.patch("/reviews/:reviewId/status", authenticate, requireEmployee, updateReviewStatus);
router.get("/branches/:branchId/reviews", authenticate, requireEmployee, getBranchReviews);

export default router;
