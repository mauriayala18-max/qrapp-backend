import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";
import {
  assertSessionActive,
  listActiveParticipantIds,
  loadActiveParticipant,
  loadSessionContext,
  requireParticipantActor,
  requireStaffActor,
  resolveSessionActor,
  type SessionContext,
} from "../sessions/session-actor.js";
import { isMissingRelation } from "./expulsion-guard.js";

/**
 * Removing a diner from a table, by the table's own decision or by staff.
 *
 * Two rules shape everything here:
 *
 *   - A majority expulsion is a decision of the WHOLE table, not of a pair of
 *     diners. It needs at least three people seated and the agreement of
 *     everyone except the target, and every count is recomputed from the live
 *     participant list at the moment of the vote - a quorum captured when the
 *     proposal opened would let two diners wait for the others to leave.
 *   - An expulsion never touches money. The target's orders stay exactly as
 *     they are; what is removed is their seat, not their bill.
 */

/** The smallest table that may expel by majority; below it, staff decide. */
const MIN_PARTICIPANTS_FOR_MAJORITY = 3;

const MAX_REASON_TYPE_LENGTH = 60;
const MAX_REASON_TEXT_LENGTH = 500;

export interface ExpulsionOutcome {
  proposal_id: string | null;
  status: "open" | "executed" | "cancelled";
  votes: number;
  votes_required: number;
  active_participants: number;
  expelled: boolean;
  expulsion_record_id: string | null;
}

/**
 * The migration for these tables is run by hand in Supabase. Saying so
 * explicitly beats a raw PostgREST error that reads like a server bug.
 */
const guardInstalled = (error: { code?: string; message?: string } | null): void => {
  if (error && isMissingRelation(error)) {
    throw createError(
      "The expulsion tables are not installed yet; run the 20260908_expulsions_and_sealing migration",
      503,
      "EXPULSIONS_NOT_INSTALLED",
    );
  }
};

/** Every expulsion must say why - a quick reason type, optional free text. */
export const normalizeReason = (
  reasonType: unknown,
  reasonText: unknown,
): { reason_type: string; reason_text: string | null } => {
  const type = typeof reasonType === "string" ? reasonType.trim() : "";

  if (!type) {
    throw createError("reason_type is required", 400, "REASON_REQUIRED");
  }

  if (type.length > MAX_REASON_TYPE_LENGTH) {
    throw createError("reason_type is too long", 400, "REASON_INVALID");
  }

  const text = typeof reasonText === "string" ? reasonText.trim() : "";

  if (text.length > MAX_REASON_TEXT_LENGTH) {
    throw createError("reason_text is too long", 400, "REASON_INVALID");
  }

  return { reason_type: type, reason_text: text ? text : null };
};

/** Votes only count while their voter is still seated. */
const countLiveVotes = async (proposalId: string, activeIds: string[]): Promise<number> => {
  const { data, error } = await supabaseAdmin
    .from("expulsion_votes")
    .select("voter_participant_id")
    .eq("proposal_id", proposalId);

  guardInstalled(error);
  if (error) throw createError(error.message, 500, "VOTE_LOOKUP_FAILED");

  const active = new Set(activeIds);

  return ((data ?? []) as Array<Record<string, unknown>>).filter((row) =>
    active.has(row["voter_participant_id"] as string),
  ).length;
};

const closeProposal = async (proposalId: string, status: "executed" | "cancelled"): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("expulsion_proposals")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("status", "open");

  if (error) {
    logger.error({ err: error, proposal_id: proposalId, status }, "failed to close expulsion proposal");
  }
};

/** The unrevoked ban already standing against this diner in this session. */
const findActiveRecordFor = async (
  sessionId: string,
  target: Record<string, unknown>,
): Promise<string | null> => {
  const userId = (target["user_id"] as string | null) ?? null;
  const webName = (target["web_name"] as string | null) ?? null;

  let query = supabaseAdmin
    .from("expulsion_records")
    .select("id")
    .eq("session_id", sessionId)
    .eq("readmitted", false);

  query = userId
    ? query.eq("target_user_id", userId)
    : query.is("target_user_id", null).eq("target_web_name", webName);

  const { data } = await query.limit(1);

  return (((data ?? [])[0] as Record<string, unknown> | undefined)?.["id"] as string | undefined) ?? null;
};

/**
 * Carry out the removal: write the permanent record, disconnect the diner, and
 * drop any lock request they had pending.
 *
 * The record is written FIRST and the seat is taken away second, because the
 * two writes cannot share a transaction. Written in that order, a failure
 * between them leaves a diner who is banned but still seated - annoying, and
 * fixable by a retry or by staff. The opposite order would leave a diner who
 * was thrown out but not banned, and they would simply scan the QR again.
 *
 * Both writes are idempotent: the record is guarded by a partial unique index
 * (a duplicate means the ban already exists, which is not an error), and the
 * disconnect is conditional on `disconnected_at IS NULL`.
 */
const executeExpulsion = async (params: {
  session: SessionContext;
  target: Record<string, unknown>;
  expelledBy: "majority" | "staff";
  staffEmployeeId: string | null;
  reason: { reason_type: string; reason_text: string | null };
}): Promise<string | null> => {
  const { session, target, expelledBy, staffEmployeeId, reason } = params;
  const targetId = target["id"] as string;

  const { data: record, error: recordError } = await supabaseAdmin
    .from("expulsion_records")
    .insert({
      session_id: session.id,
      branch_id: session.branch_id,
      target_user_id: (target["user_id"] as string | null) ?? null,
      target_web_name: (target["web_name"] as string | null) ?? null,
      expelled_by: expelledBy,
      staff_employee_id: staffEmployeeId,
      reason_type: reason.reason_type,
      reason_text: reason.reason_text,
    })
    .select("id")
    .single();

  let recordId: string | null = null;

  if (recordError) {
    guardInstalled(recordError);

    if (recordError.code !== "23505") {
      throw createError(recordError.message, 500, "EXPULSION_RECORD_FAILED");
    }

    // Already banned from this session. Fall through: the seat may still need
    // to be taken away if an earlier attempt stopped halfway.
    recordId = await findActiveRecordFor(session.id, target);
  } else {
    recordId = ((record as Record<string, unknown> | null)?.["id"] as string | undefined) ?? null;
  }

  const { data: disconnected, error: disconnectError } = await supabaseAdmin
    .from("session_participants")
    .update({ disconnected_at: new Date().toISOString() })
    .eq("id", targetId)
    .is("disconnected_at", null)
    .select("id");

  if (disconnectError) {
    throw createError(disconnectError.message, 500, "EXPULSION_FAILED");
  }

  if ((disconnected ?? []).length === 0) {
    // Someone else got there first (or the diner left on their own). The ban
    // stands either way: leaving a second before the vote landed is not an
    // escape from it.
    logger.warn({ participant_id: targetId }, "expulsion target was already disconnected");
  }

  await supabaseAdmin
    .from("session_lock_requests")
    .delete()
    .eq("session_id", session.id)
    .eq("participant_id", targetId);

  logger.info(
    {
      session_id: session.id,
      participant_id: targetId,
      expelled_by: expelledBy,
      staff_employee_id: staffEmployeeId,
    },
    "participant expelled",
  );

  return recordId;
};

/** A diner who is also staff of this branch cannot be voted out by the table. */
const assertTargetIsNotStaff = async (
  target: Record<string, unknown>,
  session: SessionContext,
): Promise<void> => {
  const userId = target["user_id"] as string | null;
  if (!userId) return;

  const { data: employee, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("auth_user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "EMPLOYEE_LOOKUP_FAILED");
  }

  if (!employee) return;

  const { data: assignment } = await supabaseAdmin
    .from("employee_branches")
    .select("branch_id")
    .eq("employee_id", (employee as Record<string, unknown>)["id"] as string)
    .eq("branch_id", session.branch_id)
    .eq("is_active", true)
    .maybeSingle();

  if (assignment) {
    throw createError("Restaurant staff cannot be expelled by the table", 403, "CANNOT_EXPEL_STAFF");
  }
};

/**
 * Open a proposal to expel a diner. The proposer is counted as the first vote,
 * so a two-person confirmation at a three-person table resolves immediately on
 * the second vote.
 */
export const proposeExpulsion = async (params: {
  sessionId: string;
  authUserId: string;
  targetParticipantId: string;
  reasonType: unknown;
  reasonText: unknown;
}): Promise<ExpulsionOutcome> => {
  const { sessionId, authUserId, targetParticipantId } = params;

  const reason = normalizeReason(params.reasonType, params.reasonText);

  const session = await loadSessionContext(sessionId);
  assertSessionActive(session);

  const actor = await resolveSessionActor(authUserId, session);
  const proposer = requireParticipantActor(actor, session);

  const activeIds = await listActiveParticipantIds(session.id);

  if (activeIds.length < MIN_PARTICIPANTS_FOR_MAJORITY) {
    throw createError(
      "A table needs at least three diners to vote someone out; ask the staff instead",
      409,
      "NOT_ENOUGH_PARTICIPANTS",
      { active_participants: activeIds.length, required: MIN_PARTICIPANTS_FOR_MAJORITY },
    );
  }

  if (targetParticipantId === proposer.participantId) {
    throw createError("You cannot propose expelling yourself", 400, "INVALID_TARGET");
  }

  const target = await loadActiveParticipant(session.id, targetParticipantId);

  if (!target) {
    throw createError("That diner is not at this table", 404, "TARGET_NOT_FOUND");
  }

  await assertTargetIsNotStaff(target, session);

  const { data: proposal, error: proposalError } = await supabaseAdmin
    .from("expulsion_proposals")
    .insert({
      session_id: session.id,
      target_participant_id: targetParticipantId,
      proposed_by_participant_id: proposer.participantId,
      reason_type: reason.reason_type,
      reason_text: reason.reason_text,
      status: "open",
    })
    .select("id")
    .single();

  if (proposalError) {
    guardInstalled(proposalError);

    if (proposalError.code === "23505") {
      throw createError(
        "There is already an open proposal against that diner",
        409,
        "PROPOSAL_ALREADY_OPEN",
      );
    }

    throw createError(proposalError.message, 500, "PROPOSAL_CREATE_FAILED");
  }

  const proposalId = (proposal as Record<string, unknown>)["id"] as string;

  const { error: voteError } = await supabaseAdmin
    .from("expulsion_votes")
    .insert({ proposal_id: proposalId, voter_participant_id: proposer.participantId });

  if (voteError && voteError.code !== "23505") {
    guardInstalled(voteError);
    throw createError(voteError.message, 500, "VOTE_CREATE_FAILED");
  }

  return resolveProposalState({ proposalId, session, target, reason });
};

/** Another diner confirms an open proposal. */
export const voteExpulsion = async (params: {
  proposalId: string;
  authUserId: string;
}): Promise<ExpulsionOutcome> => {
  const { proposalId, authUserId } = params;

  const proposal = await loadProposal(proposalId);
  const session = await loadSessionContext(proposal["session_id"] as string);
  assertSessionActive(session);

  const actor = await resolveSessionActor(authUserId, session);
  const voter = requireParticipantActor(actor, session);

  if (proposal["status"] !== "open") {
    throw createError("This proposal is no longer open", 409, "PROPOSAL_NOT_OPEN", {
      status: proposal["status"],
    });
  }

  const targetId = proposal["target_participant_id"] as string;

  if (voter.participantId === targetId) {
    throw createError("You cannot vote on your own expulsion", 403, "TARGET_CANNOT_VOTE");
  }

  const activeIds = await listActiveParticipantIds(session.id);

  // The table shrank below the threshold, or the target already left: either
  // way the vote has lost its meaning, so the proposal closes itself.
  if (activeIds.length < MIN_PARTICIPANTS_FOR_MAJORITY) {
    await closeProposal(proposalId, "cancelled");
    throw createError(
      "The table dropped below three diners, so the proposal was cancelled",
      409,
      "PROPOSAL_AUTO_CANCELLED",
      { active_participants: activeIds.length },
    );
  }

  const target = await loadActiveParticipant(session.id, targetId);

  if (!target) {
    await closeProposal(proposalId, "cancelled");
    throw createError(
      "That diner already left the table, so the proposal was cancelled",
      409,
      "PROPOSAL_AUTO_CANCELLED",
    );
  }

  const { error: voteError } = await supabaseAdmin
    .from("expulsion_votes")
    .insert({ proposal_id: proposalId, voter_participant_id: voter.participantId });

  if (voteError) {
    guardInstalled(voteError);

    if (voteError.code === "23505") {
      throw createError("You already voted on this proposal", 409, "ALREADY_VOTED");
    }

    throw createError(voteError.message, 500, "VOTE_CREATE_FAILED");
  }

  return resolveProposalState({
    proposalId,
    session,
    target,
    reason: {
      reason_type: proposal["reason_type"] as string,
      reason_text: (proposal["reason_text"] as string | null) ?? null,
    },
  });
};

/**
 * Count the live votes and execute if everyone except the target agreed.
 * Shared by the propose and vote paths so the threshold is defined once.
 *
 * The roster is read again HERE, after the caller's vote is already stored,
 * and never reused from the caller's earlier read. A diner who sat down while
 * the vote was being cast must raise the bar, not be ignored by a count taken
 * a moment before they arrived.
 */
const resolveProposalState = async (params: {
  proposalId: string;
  session: SessionContext;
  target: Record<string, unknown>;
  reason: { reason_type: string; reason_text: string | null };
}): Promise<ExpulsionOutcome> => {
  const { proposalId, session, target, reason } = params;

  const activeIds = await listActiveParticipantIds(session.id);
  const votesRequired = activeIds.length - 1;
  const votes = await countLiveVotes(proposalId, activeIds);

  if (votes < votesRequired) {
    return {
      proposal_id: proposalId,
      status: "open",
      votes,
      votes_required: votesRequired,
      active_participants: activeIds.length,
      expelled: false,
      expulsion_record_id: null,
    };
  }

  const recordId = await executeExpulsion({
    session,
    target,
    expelledBy: "majority",
    staffEmployeeId: null,
    reason,
  });

  await closeProposal(proposalId, "executed");

  return {
    proposal_id: proposalId,
    status: "executed",
    votes,
    votes_required: votesRequired,
    active_participants: activeIds.length,
    expelled: true,
    expulsion_record_id: recordId,
  };
};

const loadProposal = async (proposalId: string): Promise<Record<string, unknown>> => {
  const { data, error } = await supabaseAdmin
    .from("expulsion_proposals")
    .select("id, session_id, target_participant_id, proposed_by_participant_id, reason_type, reason_text, status")
    .eq("id", proposalId)
    .maybeSingle();

  if (error) {
    guardInstalled(error);
    throw createError(error.message, 500, "PROPOSAL_LOOKUP_FAILED");
  }

  if (!data) {
    throw createError("Proposal not found", 404, "PROPOSAL_NOT_FOUND");
  }

  return data as Record<string, unknown>;
};

/** The proposer calls off their own proposal. */
export const cancelProposal = async (params: {
  proposalId: string;
  authUserId: string;
}): Promise<{ proposal_id: string; status: "cancelled" }> => {
  const { proposalId, authUserId } = params;

  const proposal = await loadProposal(proposalId);
  const session = await loadSessionContext(proposal["session_id"] as string);

  const actor = await resolveSessionActor(authUserId, session);
  const participant = requireParticipantActor(actor, session);

  if (participant.participantId !== proposal["proposed_by_participant_id"]) {
    throw createError("Only the diner who opened this proposal can cancel it", 403, "NOT_PROPOSER");
  }

  if (proposal["status"] !== "open") {
    throw createError("This proposal is no longer open", 409, "PROPOSAL_NOT_OPEN", {
      status: proposal["status"],
    });
  }

  await closeProposal(proposalId, "cancelled");

  return { proposal_id: proposalId, status: "cancelled" };
};

/** Staff remove a diner directly: no vote, same effects, same audit trail. */
export const staffExpel = async (params: {
  sessionId: string;
  authUserId: string;
  targetParticipantId: string;
  reasonType: unknown;
  reasonText: unknown;
}): Promise<{ expelled: boolean; expulsion_record_id: string | null; participant_id: string }> => {
  const { sessionId, authUserId, targetParticipantId } = params;

  const reason = normalizeReason(params.reasonType, params.reasonText);

  const session = await loadSessionContext(sessionId);
  assertSessionActive(session);

  const actor = await resolveSessionActor(authUserId, session);
  const staff = requireStaffActor(actor, session);

  const target = await loadActiveParticipant(session.id, targetParticipantId);

  if (!target) {
    throw createError("That diner is not at this table", 404, "TARGET_NOT_FOUND");
  }

  const recordId = await executeExpulsion({
    session,
    target,
    expelledBy: "staff",
    staffEmployeeId: staff.employeeId,
    reason,
  });

  // A vote in progress against the same diner has nothing left to decide.
  const { data: openProposals } = await supabaseAdmin
    .from("expulsion_proposals")
    .select("id")
    .eq("session_id", session.id)
    .eq("target_participant_id", targetParticipantId)
    .eq("status", "open");

  for (const row of (openProposals ?? []) as Array<Record<string, unknown>>) {
    await closeProposal(row["id"] as string, "cancelled");
  }

  return { expelled: true, expulsion_record_id: recordId, participant_id: targetParticipantId };
};

/**
 * Staff lift an expulsion. The record is kept and marked readmitted rather
 * than deleted: the history of who was removed, and who let them back in, is
 * the whole point of the audit trail.
 */
export const readmit = async (params: {
  recordId: string;
  authUserId: string;
  comment: unknown;
}): Promise<Record<string, unknown>> => {
  const { recordId, authUserId } = params;

  const comment = typeof params.comment === "string" ? params.comment.trim() : "";

  if (!comment) {
    throw createError("readmission_comment is required", 400, "COMMENT_REQUIRED");
  }

  if (comment.length > MAX_REASON_TEXT_LENGTH) {
    throw createError("readmission_comment is too long", 400, "COMMENT_INVALID");
  }

  const { data: record, error } = await supabaseAdmin
    .from("expulsion_records")
    .select("id, session_id, branch_id, readmitted")
    .eq("id", recordId)
    .maybeSingle();

  if (error) {
    guardInstalled(error);
    throw createError(error.message, 500, "RECORD_LOOKUP_FAILED");
  }

  if (!record) {
    throw createError("Expulsion record not found", 404, "RECORD_NOT_FOUND");
  }

  const row = record as Record<string, unknown>;

  // Authorization is branch-scoped and deliberately does NOT require the
  // session to still be active: a record can be revoked after the table closed.
  const session = await loadSessionContext(row["session_id"] as string);
  const actor = await resolveSessionActor(authUserId, session);
  const staff = requireStaffActor(actor, session);

  if (row["readmitted"] === true) {
    throw createError("That diner was already readmitted", 409, "ALREADY_READMITTED");
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from("expulsion_records")
    .update({
      readmitted: true,
      readmitted_by_employee_id: staff.employeeId,
      readmission_comment: comment,
      readmitted_at: new Date().toISOString(),
    })
    .eq("id", recordId)
    .eq("readmitted", false)
    .select("id, session_id, target_user_id, target_web_name, readmitted, readmission_comment, readmitted_at")
    .maybeSingle();

  if (updateError) {
    throw createError(updateError.message, 500, "READMISSION_FAILED");
  }

  if (!updated) {
    throw createError("That diner was already readmitted", 409, "ALREADY_READMITTED");
  }

  logger.info(
    { record_id: recordId, employee_id: staff.employeeId, session_id: row["session_id"] },
    "expulsion readmitted",
  );

  return updated as Record<string, unknown>;
};
