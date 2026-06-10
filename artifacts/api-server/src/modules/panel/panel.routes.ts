import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireEmployee } from "../../middleware/employee.js";
import { requireRole } from "../../middleware/roles.js";
import * as panel from "./panel.controller.js";

const router: IRouter = Router();

const admin = requireRole("admin");
const adminOrManager = requireRole("admin", "manager");

router.get("/branches/:branchId/dashboard", authenticate, requireEmployee, adminOrManager, panel.getDashboard);
router.get("/branches/:branchId/statistics", authenticate, requireEmployee, admin, panel.getStatistics);

router.get("/branches/:branchId/employees", authenticate, requireEmployee, admin, panel.getEmployees);
router.post("/branches/:branchId/employees", authenticate, requireEmployee, admin, panel.createEmployee);
router.patch("/employees/:employeeId", authenticate, requireEmployee, admin, panel.updateEmployee);
router.post("/employees/:employeeId/deactivate", authenticate, requireEmployee, admin, panel.deactivateEmployee);
router.post("/employees/:employeeId/reactivate", authenticate, requireEmployee, admin, panel.reactivateEmployee);
router.get("/branches/:branchId/waiter-assignments", authenticate, requireEmployee, adminOrManager, panel.getWaiterAssignments);
router.post("/branches/:branchId/waiter-assignments", authenticate, requireEmployee, adminOrManager, panel.setWaiterAssignments);

router.get("/branches/:branchId/clients", authenticate, requireEmployee, admin, panel.getClients);
router.get("/clients/:userId/profile", authenticate, requireEmployee, admin, panel.getClientProfile);

router.get("/branches/:branchId/settings", authenticate, requireEmployee, admin, panel.getBranchSettings);
router.patch("/branches/:branchId/settings", authenticate, requireEmployee, admin, panel.updateBranchSettings);
router.put("/branches/:branchId/hours", authenticate, requireEmployee, admin, panel.replaceBranchHours);
router.post("/branches/:branchId/photos", authenticate, requireEmployee, admin, panel.addBranchPhoto);
router.delete("/photos/:photoId", authenticate, requireEmployee, admin, panel.deleteBranchPhoto);
router.put("/branches/:branchId/payment-methods", authenticate, requireEmployee, admin, panel.setPaymentMethods);
router.get("/branches/:branchId/tables", authenticate, requireEmployee, adminOrManager, panel.getTables);
router.post("/branches/:branchId/tables", authenticate, requireEmployee, admin, panel.createTable);
router.patch("/tables/:tableId", authenticate, requireEmployee, admin, panel.updateTable);

router.get("/branches/:branchId/alerts", authenticate, requireEmployee, panel.getAlerts);
router.patch("/alerts/:alertId", authenticate, requireEmployee, panel.updateAlert);

export default router;
