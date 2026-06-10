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

const router: IRouter = Router();

router.post("/branches/:branchId/products", authenticate, requireEmployee, createProduct);
router.patch("/products/:productId", authenticate, requireEmployee, updateProduct);
router.patch("/products/:productId/availability", authenticate, requireEmployee, toggleProductAvailability);
router.delete("/products/:productId", authenticate, requireEmployee, deleteProduct);
router.post("/branches/:branchId/categories", authenticate, requireEmployee, createCategory);
router.patch("/categories/:categoryId", authenticate, requireEmployee, updateCategory);
router.get("/branches/:branchId/menu/changelog", authenticate, requireEmployee, getChangeLog);

export default router;
