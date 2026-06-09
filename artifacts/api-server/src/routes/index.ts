import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "../modules/auth/auth.routes.js";

const router: IRouter = Router();

router.use(healthRouter);

router.get("/v1/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.use("/v1/auth", authRouter);

export default router;
