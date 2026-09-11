import { Router, type IRouter } from "express";
import { optionalAuthenticate } from "../../middleware/employee.js";
import * as tablesController from "./tables.controller.js";

const router: IRouter = Router();

// Diners arrive here straight from the printed sticker, logged in or not.
router.post("/:tableId/scan", optionalAuthenticate, tablesController.scanTable);

export default router;
