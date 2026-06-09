import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { authRateLimiter } from "../../middleware/rateLimiter.js";
import * as authController from "./auth.controller.js";

const router: IRouter = Router();

router.post("/register", authRateLimiter, authController.register);
router.post("/login", authRateLimiter, authController.login);
router.post("/social", authRateLimiter, authController.socialAuth);
router.get("/me", authenticate, authController.getMe);
router.patch("/me", authenticate, authController.updateMe);
router.post("/employee/login", authRateLimiter, authController.employeeLogin);
router.post("/terms/accept", authenticate, authController.acceptTerms);

export default router;
