import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "../modules/auth/auth.routes.js";
import sessionsRouter from "../modules/sessions/sessions.routes.js";
import ordersRouter from "../modules/orders/orders.routes.js";
import waiterCallsRouter from "../modules/waiter-calls/waiter-calls.routes.js";
import branchesRouter from "./branches.js";
import cancellationsRouter from "./cancellations.js";

const router: IRouter = Router();

router.use(healthRouter);

router.get("/v1/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.use("/v1/auth", authRouter);
router.use("/v1/sessions", sessionsRouter);
router.use("/v1/orders", ordersRouter);
router.use("/v1/waiter-calls", waiterCallsRouter);
router.use("/v1/branches", branchesRouter);
router.use("/v1/cancellations", cancellationsRouter);

export default router;
