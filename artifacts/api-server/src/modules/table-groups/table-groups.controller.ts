import { type Request, type Response, type NextFunction } from "express";
import * as tableGroupsService from "./table-groups.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const createTableGroup = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { table_ids, name } = req.body as {
      table_ids?: string[];
      name?: string;
    };

    if (!Array.isArray(table_ids) || table_ids.length === 0) {
      return next(createError("table_ids array is required", 400, "MISSING_FIELDS"));
    }

    const result = await tableGroupsService.createTableGroup({
      branchId,
      tableIds: table_ids,
      name,
      authUserId: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getTableGroups = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await tableGroupsService.getTableGroups(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const deleteTableGroup = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { groupId } = req.params as { groupId: string };
    await tableGroupsService.deleteTableGroup(groupId);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
};
