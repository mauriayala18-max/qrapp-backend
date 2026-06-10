import { Router, type IRouter } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireEmployee, optionalAuthenticate } from "../middleware/employee.js";
import { getActiveOrders } from "../modules/orders/orders.controller.js";
import { getBranchWaiterCalls } from "../modules/waiter-calls/waiter-calls.controller.js";
import { getBranchMenu, searchMenu, getFeaturedProducts } from "../modules/menu/menu.controller.js";
import { getBankingBenefits } from "../modules/payments/payments.controller.js";
import { getBranchPromotions } from "../modules/promotions/promotions.controller.js";

const router: IRouter = Router();

router.get("/:branchId/orders/active", authenticate, requireEmployee, getActiveOrders);
router.get("/:branchId/waiter-calls", authenticate, requireEmployee, getBranchWaiterCalls);
router.get("/:branchId/menu", getBranchMenu);
router.get("/:branchId/menu/search", searchMenu);
router.get("/:branchId/menu/featured", getFeaturedProducts);
router.get("/:branchId/banking-benefits", optionalAuthenticate, getBankingBenefits);
router.get("/:branchId/promotions", optionalAuthenticate, getBranchPromotions);

export default router;
