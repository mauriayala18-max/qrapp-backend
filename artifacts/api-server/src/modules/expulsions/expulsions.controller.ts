import { type Request, type Response, type NextFunction } from "express";
import * as expulsionsService from "./expulsions.service.js";

export const proposeExpulsion = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { target_participant_id, reason_type, reason_text } = req.body as Record<string, unknown>;

    const result = await expulsionsService.proposeExpulsion({
      sessionId,
      authUserId: req.user!.id,
      targetParticipantId: String(target_participant_id ?? ""),
      reasonType: reason_type,
      reasonText: reason_text,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const voteExpulsion = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { proposalId } = req.params as { proposalId: string };

    const result = await expulsionsService.voteExpulsion({
      proposalId,
      authUserId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const cancelProposal = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { proposalId } = req.params as { proposalId: string };

    const result = await expulsionsService.cancelProposal({
      proposalId,
      authUserId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const staffExpel = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { target_participant_id, reason_type, reason_text } = req.body as Record<string, unknown>;

    const result = await expulsionsService.staffExpel({
      sessionId,
      authUserId: req.user!.id,
      targetParticipantId: String(target_participant_id ?? ""),
      reasonType: reason_type,
      reasonText: reason_text,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const readmit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { recordId } = req.params as { recordId: string };
    const { readmission_comment } = req.body as Record<string, unknown>;

    const result = await expulsionsService.readmit({
      recordId,
      authUserId: req.user!.id,
      comment: readmission_comment,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
