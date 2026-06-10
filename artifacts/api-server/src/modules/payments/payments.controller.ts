import { type Request, type Response, type NextFunction } from "express";
import * as paymentsService from "./payments.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const createPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      session_id,
      amount,
      payment_method,
      card_id,
      banking_benefit_id,
      tip_amount,
      tip_type,
      billing_profile_id,
    } = req.body as {
      session_id?: string;
      amount?: number;
      payment_method?: "card" | "apple_pay" | "google_pay" | "pos" | "cash";
      card_id?: string;
      banking_benefit_id?: string;
      tip_amount?: number;
      tip_type?: "digital" | "cash";
      billing_profile_id?: string;
    };

    if (!session_id || amount === undefined || !payment_method) {
      return next(createError("session_id, amount, and payment_method are required", 400, "MISSING_FIELDS"));
    }

    const result = await paymentsService.createPayment({
      session_id,
      amount,
      payment_method,
      card_id,
      banking_benefit_id,
      tip_amount,
      tip_type,
      billing_profile_id,
      userId: req.user?.id,
      isEmployee: req.body["_isEmployee"] as boolean ?? false,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getSessionPayments = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const result = await paymentsService.getSessionPayments(sessionId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getReceipt = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { paymentId } = req.params as { paymentId: string };
    const result = await paymentsService.getReceipt(paymentId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createSplit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { split_method, participants_count } = req.body as {
      split_method?: "equal" | "choose_mine" | "custom_amount";
      participants_count?: number;
    };

    if (!split_method || participants_count === undefined) {
      return next(createError("split_method and participants_count are required", 400, "MISSING_FIELDS"));
    }

    const result = await paymentsService.createSplit({
      sessionId,
      split_method,
      participants_count,
      userId: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const claimSplitItems = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { splitId } = req.params as { splitId: string };
    const { items } = req.body as {
      items?: Array<{ order_item_id: string; is_shared?: boolean }>;
    };

    if (!items?.length) {
      return next(createError("items array is required", 400, "MISSING_FIELDS"));
    }

    const result = await paymentsService.claimSplitItems({
      splitId,
      items,
      userId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getSplit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { splitId } = req.params as { splitId: string };
    const result = await paymentsService.getSplit(splitId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createPaymentLink = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { amount } = req.body as { amount?: number };

    if (amount === undefined) {
      return next(createError("amount is required", 400, "MISSING_FIELDS"));
    }

    const result = await paymentsService.createPaymentLink({
      sessionId,
      amount,
      userId: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getPaymentLink = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { linkId } = req.params as { linkId: string };
    const result = await paymentsService.getPaymentLink(linkId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const completePaymentLink = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { linkId } = req.params as { linkId: string };
    const { payment_method, card_id } = req.body as {
      payment_method?: string;
      card_id?: string;
    };

    if (!payment_method) {
      return next(createError("payment_method is required", 400, "MISSING_FIELDS"));
    }

    const result = await paymentsService.completePaymentLink({
      linkId,
      payment_method,
      card_id,
      userId: req.user?.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createInvoice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { billing_profile_id, customer_name, ruc } = req.body as {
      billing_profile_id?: string;
      customer_name?: string;
      ruc?: string;
    };

    const result = await paymentsService.createInvoice({
      sessionId,
      billing_profile_id,
      customer_name,
      ruc,
      userId: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getSessionInvoices = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const result = await paymentsService.getSessionInvoices(sessionId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getBankingBenefits = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await paymentsService.getBankingBenefits({
      branchId,
      userId: req.user?.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
