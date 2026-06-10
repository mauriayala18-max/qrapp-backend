import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "../modules/auth/auth.routes.js";
import sessionsRouter from "../modules/sessions/sessions.routes.js";
import ordersRouter from "../modules/orders/orders.routes.js";
import waiterCallsRouter from "../modules/waiter-calls/waiter-calls.routes.js";
import branchesRouter from "./branches.js";
import cancellationsRouter from "./cancellations.js";
import productsRouter from "./products.js";
import panelRouter from "./panel.js";
import paymentsRouter from "../modules/payments/payments.routes.js";
import splitsRouter from "./splits.js";
import payRouter from "./pay.js";

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
router.use("/v1/products", productsRouter);
router.use("/v1/panel", panelRouter);
router.use("/v1/payments", paymentsRouter);
router.use("/v1/splits", splitsRouter);
router.use("/v1/pay", payRouter);

export default router;
