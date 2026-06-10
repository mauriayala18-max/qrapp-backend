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
import reservationsRouter from "../modules/reservations/reservations.routes.js";
import pointsRouter from "../modules/points/points.routes.js";
import promotionsRouter from "../modules/promotions/promotions.routes.js";
import couponsRouter from "./coupons.js";
import ratingsRouter from "../modules/ratings/ratings.routes.js";
import notificationsRouter from "../modules/notifications/notifications.routes.js";

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
router.use("/v1/reservations", reservationsRouter);
router.use("/v1/points", pointsRouter);
router.use("/v1/promotions", promotionsRouter);
router.use("/v1/coupons", couponsRouter);
router.use("/v1/ratings", ratingsRouter);
router.use("/v1/notifications", notificationsRouter);

export default router;
