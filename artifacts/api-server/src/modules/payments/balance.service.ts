import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

/**
 * Single source of truth for "how much of this table's bill is still owed".
 *
 * Every consumer (GET /sessions/:id/payments, session close and invoice
 * generation) MUST go through `computeSessionBalance` so the API and the
 * close/invoice guards can never disagree.
 *
 * Money rules (all amounts are integer Guaraníes):
 *  - total_ordered            sum of NON-cancelled orders.
 *  - total_paid               sum of payments.amount where status='completed'.
 *  - total_discount_absorbed  discount_amount of completed payments whose
 *                             banking benefit is restaurant-absorbed
 *                             (benefit_type='discount'). Those Gs are never
 *                             collected from anyone, so they must settle the
 *                             bill instead of leaving a phantom remainder.
 *                             'reimbursement' benefits are bank-absorbed: the
 *                             customer pays full, so no adjustment is made.
 *  - tip_amount               EXCLUDED from settlement entirely.
 */
export interface SessionBalance {
  total_ordered: number;
  total_paid: number;
  total_discount_absorbed: number;
  remaining: number;
  is_settled: boolean;
  pending_participant_count: number;
}

/** Guaraníes are integers - never let float drift reach the API. */
const gs = (value: number): number => Math.round(value);

type PaymentRow = {
  amount: number | null;
  discount_amount: number | null;
  status: string | null;
  user_id: string | null;
  participant_id: string | null;
  banking_benefit_id: string | null;
};

/**
 * A read that silently returns no rows would understate the bill and let a
 * table close while money is still owed, so every query fails closed.
 */
const orFail = <T>(result: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (result.error) {
    throw createError(`Failed to read ${what}: ${result.error.message}`, 500, "BALANCE_READ_FAILED");
  }
  return (result.data ?? []) as T;
};

export const computeSessionBalance = async (
  sessionId: string,
): Promise<SessionBalance> => {
  const [orderResult, paymentResult] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("total_amount")
      .eq("session_id", sessionId)
      .neq("status", "cancelled"),
    supabaseAdmin
      .from("payments")
      .select("amount, discount_amount, status, user_id, participant_id, banking_benefit_id")
      .eq("session_id", sessionId),
  ]);

  const orders = orFail<Array<Record<string, unknown>>>(orderResult, "orders");
  const payments = orFail<PaymentRow[]>(paymentResult, "payments");

  const total_ordered = gs(
    orders.reduce(
      (sum: number, o: Record<string, unknown>) => sum + ((o["total_amount"] as number) ?? 0),
      0,
    ),
  );

  const completed = payments.filter((p) => p.status === "completed");

  const total_paid = gs(completed.reduce((sum, p) => sum + (p.amount ?? 0), 0));

  // Only restaurant-absorbed ('discount') benefits count toward settlement.
  const benefitIds = [
    ...new Set(
      completed
        .filter((p) => (p.discount_amount ?? 0) > 0 && p.banking_benefit_id)
        .map((p) => p.banking_benefit_id as string),
    ),
  ];

  let absorbedBenefitIds = new Set<string>();
  if (benefitIds.length > 0) {
    const benefits = orFail<Array<Record<string, unknown>>>(
      await supabaseAdmin.from("banking_benefits").select("id, benefit_type").in("id", benefitIds),
      "banking benefits",
    );

    absorbedBenefitIds = new Set(
      benefits
        .filter((b: Record<string, unknown>) => b["benefit_type"] === "discount")
        .map((b: Record<string, unknown>) => b["id"] as string),
    );
  }

  const total_discount_absorbed = gs(
    completed.reduce(
      (sum, p) =>
        p.banking_benefit_id && absorbedBenefitIds.has(p.banking_benefit_id)
          ? sum + (p.discount_amount ?? 0)
          : sum,
      0,
    ),
  );

  const settled = total_paid + total_discount_absorbed;
  const remaining = Math.max(0, gs(total_ordered - settled));
  const is_settled = remaining === 0;

  const pending_participant_count = is_settled
    ? 0
    : await countPendingParticipants(sessionId, completed);

  return {
    total_ordered,
    total_paid,
    total_discount_absorbed,
    remaining,
    is_settled,
    pending_participant_count,
  };
};

/**
 * How many payers still owe money: diners covered by the split (equal /
 * choose_mine / custom) who have not completed a payment, plus outstanding
 * payment links handed to non-connected diners.
 */
const countPendingParticipants = async (
  sessionId: string,
  completed: PaymentRow[],
): Promise<number> => {
  // One payment identifies its payer by participant_id, user_id, or both.
  // Collapse each payment to a single key so one payer is never counted twice.
  const distinctPayers = new Set(
    completed
      .map((p) => p.participant_id ?? p.user_id)
      .filter((id): id is string => Boolean(id)),
  );
  const paidParticipantIds = new Set(
    completed.map((p) => p.participant_id).filter((id): id is string => Boolean(id)),
  );
  const paidUserIds = new Set(
    completed.map((p) => p.user_id).filter((id): id is string => Boolean(id)),
  );

  const [participantResult, linkResult, splitResult] = await Promise.all([
    supabaseAdmin.from("session_participants").select("id, user_id").eq("session_id", sessionId),
    supabaseAdmin
      .from("payment_links")
      .select("id, expires_at")
      .eq("session_id", sessionId)
      .eq("status", "active"),
    supabaseAdmin
      .from("account_splits")
      .select("id, split_method, total_participants")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const roster = orFail<Array<{ id: string; user_id: string | null }>>(
    participantResult,
    "session participants",
  );
  const links = orFail<Array<Record<string, unknown>>>(linkResult, "payment links");
  const splits = orFail<
    Array<{ id: string; split_method: string | null; total_participants: number | null }>
  >(splitResult, "account splits");

  const now = Date.now();
  const openLinks = links.filter((l) => {
    const expiresAt = l["expires_at"] as string | null;
    return !expiresAt || new Date(expiresAt).getTime() > now;
  }).length;

  const hasPaid = (p: { id: string; user_id: string | null }): boolean =>
    paidParticipantIds.has(p.id) || (p.user_id !== null && paidUserIds.has(p.user_id));
  const unpaidRoster = roster.filter((p) => !hasPaid(p)).length;

  const split = splits[0];

  let owing: number;

  if (split?.split_method === "equal") {
    const expected = split.total_participants ?? roster.length;
    owing = Math.max(0, expected - distinctPayers.size);
  } else if (split?.split_method === "choose_mine") {
    const claims = orFail<Array<Record<string, unknown>>>(
      await supabaseAdmin.from("claimed_items").select("participant_id").eq("split_id", split.id),
      "claimed items",
    );

    const claimants = new Set(
      claims
        .map((c) => c["participant_id"] as string | null)
        .filter((id): id is string => Boolean(id)),
    );

    owing =
      claimants.size > 0
        ? [...claimants].filter((id) => !paidParticipantIds.has(id)).length
        : unpaidRoster;
  } else {
    // custom_amount, or no split recorded: everyone who has not paid still owes.
    owing = unpaidRoster;
  }

  const pending = owing + openLinks;

  // Money is still outstanding, so at least one payer is pending even when the
  // roster is empty (e.g. an unclaimed walk-in bill).
  return pending > 0 ? pending : 1;
};
