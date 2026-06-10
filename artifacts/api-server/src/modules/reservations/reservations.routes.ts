import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as reservationsController from "./reservations.controller.js";

const router: IRouter = Router();

router.post("/", authenticate, reservationsController.createReservation);
router.get("/mine", authenticate, reservationsController.getMyReservations);
router.delete("/:reservationId", authenticate, reservationsController.cancelReservation);

export default router;
