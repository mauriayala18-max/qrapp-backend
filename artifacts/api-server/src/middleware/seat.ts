import { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { createError } from "./errorHandler.js";
import { logger } from "../lib/logger.js";
import {
  SEAT_TOKEN_HEADER,
  SEAT_TOKEN_ISSUED_HEADER,
  generateSeatToken,
  hashSeatToken,
  isSeatTokenEnforced,
  readPresentedSeatToken,
  seatTokenColumnsReady,
  seatTokenMatches,
} from "../lib/seat-token.js";
import {
  assertSessionActive,
  loadSessionContext,
  resolveStaff,
  type SessionContext,
} from "../modules/sessions/session-actor.js";
import { assertNotExpelled } from "../modules/expulsions/expulsion-guard.js";
import type { SeatParticipant } from "../types/index.js";

/**
 * requireSeat - the ONE gate for every diner action that changes state.
 *
 * The participant a request acts as is derived from the `X-Seat-Token` header
 * (sha256 + timing-safe compare against `session_participants.seat_token_hash`),
 * never from a `participant_id` in the body. On success `req.participant` holds
 * the verified seat; controllers must prefer it over anything the body says.
 *
 * Checks, in order:
 *   1. target session exists (404) - resolved per route, see the resolvers below;
 *   2. staff of the session's branch pass through when the route allows staff
 *      (`req.seatStaff`), keeping plain employee auth;
 *   3. the session is active (409 SESSION_NOT_ACTIVE) - a closed table makes
 *      every one of its tokens useless;
 *   4. the token belongs to a participant OF THIS SESSION (403 SEAT_TOKEN_INVALID),
 *      who is still connected and not expelled (403 PARTICIPANT_INACTIVE), and -
 *      when the seat carries an account - whose account matches the JWT.
 *
 * Backward compatibility: a seat with no hash yet (created before tokens
 * existed) is accepted without a token, and a token is issued on that same
 * response (`X-Seat-Token-Issued` header + `data.seat_token`). From then on
 * the token is required. SEAT_TOKEN_ENFORCE=false downgrades token rejections
 * to warnings and lets the request continue under the pre-token rules.
 */

type SessionResolver = (req: Request) => Promise<string | null> | string | null;

export interface RequireSeatOptions {
  /** Where the target session comes from. null = nothing to guard here. */
  session: SessionResolver;
  /** Branch staff of the session pass through on their employee auth. */
  allowStaff?: boolean;
  /**
   * How the handler identifies the diner.
   * - "seat": the handler acts on `req.participant` (anonymous seats allowed).
   * - "jwt": the handler resolves the diner from the JWT, so the token must
   *   belong to that same account's seat or the two could disagree.
   */
  identity: "seat" | "jwt";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEAT_COLUMNS = "id, session_id, user_id, web_name, platform, disconnected_at, seat_token_hash";

interface SeatRow {
  id: string;
  session_id: string;
  user_id: string | null;
  web_name: string | null;
  platform: string | null;
  disconnected_at: string | null;
  seat_token_hash: string | null;
}

const toSeatRow = (row: Record<string, unknown>): SeatRow => ({
  id: row["id"] as string,
  session_id: row["session_id"] as string,
  user_id: (row["user_id"] as string | null) ?? null,
  web_name: (row["web_name"] as string | null) ?? null,
  platform: (row["platform"] as string | null) ?? null,
  disconnected_at: (row["disconnected_at"] as string | null) ?? null,
  seat_token_hash: (row["seat_token_hash"] as string | null) ?? null,
});

const toParticipant = (row: SeatRow): SeatParticipant => ({
  id: row.id,
  session_id: row.session_id,
  user_id: row.user_id,
  web_name: row.web_name,
  platform: row.platform,
});

/** A refusal about the TOKEN: soft (warn + legacy rules) when not enforcing. */
class SoftReject extends Error {}

const tokenReject = (
  status: number,
  code: string,
  message: string,
  context: Record<string, unknown>,
): never => {
  if (!isSeatTokenEnforced()) {
    logger.warn({ code, ...context }, "seat token check failed (SEAT_TOKEN_ENFORCE=false: allowed)");
    throw new SoftReject(code);
  }
  logger.warn({ code, ...context }, "seat token check failed");
  throw createError(message, status, code);
};

/** A refusal about the PERSON, not the token: always hard. */
const hardReject = (
  status: number,
  code: string,
  message: string,
  context: Record<string, unknown>,
): never => {
  logger.warn({ code, ...context }, "seat action denied");
  throw createError(message, status, code);
};

const assertSeatActive = async (seat: SeatRow, context: Record<string, unknown>): Promise<void> => {
  if (seat.disconnected_at) {
    hardReject(403, "PARTICIPANT_INACTIVE", "This participant is no longer at the table", {
      ...context,
      reason: "disconnected",
    });
  }

  // The ban is the door, not the row: an expulsion race can leave the row
  // connected (see expulsion-guard.ts).
  try {
    await assertNotExpelled({
      sessionId: seat.session_id,
      userId: seat.user_id ?? undefined,
      webName: seat.user_id ? undefined : seat.web_name ?? undefined,
    });
  } catch (err) {
    if ((err as { code?: string }).code === "EXPELLED_FROM_SESSION") {
      hardReject(403, "PARTICIPANT_INACTIVE", "This participant was removed from the table", {
        ...context,
        reason: "expelled",
      });
    }
    throw err;
  }
};

const findSeatByHash = async (hash: string): Promise<SeatRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select(SEAT_COLUMNS)
    .eq("seat_token_hash", hash)
    .limit(1);

  if (error) throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  return row ? toSeatRow(row) : null;
};

/** The active seat a token-less request claims: body participant_id, else the JWT's own. */
const findClaimedSeat = async (
  req: Request,
  sessionId: string,
  identity: RequireSeatOptions["identity"],
): Promise<SeatRow | null> => {
  const bodyParticipantId = (req.body as Record<string, unknown> | undefined)?.["participant_id"];

  let query = supabaseAdmin
    .from("session_participants")
    .select(SEAT_COLUMNS)
    .eq("session_id", sessionId)
    .is("disconnected_at", null);

  if (identity === "seat" && typeof bodyParticipantId === "string" && UUID.test(bodyParticipantId)) {
    query = query.eq("id", bodyParticipantId);
  } else if (req.user) {
    query = query.eq("user_id", req.user.id);
  } else {
    return null;
  }

  const { data, error } = await query.limit(1);
  if (error) throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  return row ? toSeatRow(row) : null;
};

/** Deliver a lazily issued token on THIS response, success or error. */
const attachIssuedToken = (res: Response, token: string): void => {
  res.setHeader(SEAT_TOKEN_ISSUED_HEADER, token);

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const data = record["data"];

      if (data && typeof data === "object" && !Array.isArray(data)) {
        return originalJson({ ...record, data: { ...(data as object), seat_token: token } });
      }

      if (record["error"] === true) {
        return originalJson({ ...record, seat_token: token });
      }
    }
    return originalJson(body);
  }) as Response["json"];
};

const verifyPresentedToken = async (
  req: Request,
  session: SessionContext,
  presented: string,
  identity: RequireSeatOptions["identity"],
): Promise<SeatRow> => {
  const context = { session_id: session.id, route: req.baseUrl + req.route?.path };
  const seat = await findSeatByHash(hashSeatToken(presented));

  if (!seat || !seatTokenMatches(presented, seat.seat_token_hash)) {
    return tokenReject(403, "SEAT_TOKEN_INVALID", "Seat token is not valid", context);
  }

  const seatContext = { ...context, participant_id: seat.id };

  // A token from another table, or from this table's previous (closed) session.
  if (seat.session_id !== session.id) {
    return tokenReject(403, "SEAT_TOKEN_INVALID", "Seat token is not valid for this session", {
      ...seatContext,
      token_session_id: seat.session_id,
    });
  }

  await assertSeatActive(seat, seatContext);

  // A seat with an account behind it still needs that account's JWT.
  if (seat.user_id && !req.user) {
    hardReject(401, "AUTH_REQUIRED", "This participant must be signed in", seatContext);
  }

  // When a JWT is present, the token must be that account's own seat: a
  // signed-in caller never acts through someone else's seat (guest or not),
  // and JWT-identified handlers can never end up acting on a different seat.
  if (req.user && seat.user_id !== req.user.id) {
    return tokenReject(403, "SEAT_TOKEN_INVALID", "Seat token does not belong to your account", {
      ...seatContext,
      auth_user_id: req.user.id,
    });
  }

  if (identity === "jwt" && !req.user) {
    hardReject(401, "AUTH_REQUIRED", "Sign in is required for this action", seatContext);
  }

  const bodyParticipantId = (req.body as Record<string, unknown> | undefined)?.["participant_id"];
  if (typeof bodyParticipantId === "string" && bodyParticipantId !== seat.id) {
    logger.warn(
      { ...seatContext, body_participant_id: bodyParticipantId },
      "body participant_id ignored: the seat token decides who is acting",
    );
  }

  return seat;
};

const lazyIssueForLegacySeat = async (
  req: Request,
  res: Response,
  session: SessionContext,
  identity: RequireSeatOptions["identity"],
): Promise<SeatRow> => {
  const context = { session_id: session.id, route: req.baseUrl + req.route?.path };
  const seat = await findClaimedSeat(req, session.id, identity);

  if (!seat) {
    return tokenReject(401, "SEAT_TOKEN_MISSING", "X-Seat-Token header is required", context);
  }

  const seatContext = { ...context, participant_id: seat.id };

  if (seat.seat_token_hash) {
    return tokenReject(401, "SEAT_TOKEN_MISSING", "X-Seat-Token header is required", seatContext);
  }

  // Legacy seat with an account: only that account may claim its first token.
  if (seat.user_id && !req.user) {
    hardReject(401, "AUTH_REQUIRED", "This participant must be signed in", seatContext);
  }

  // Same rule as with a token: a signed-in caller only ever gets their own seat.
  if (req.user && seat.user_id !== req.user.id) {
    return tokenReject(401, "SEAT_TOKEN_MISSING", "X-Seat-Token header is required", {
      ...seatContext,
      auth_user_id: req.user.id,
      reason: "claimed_seat_not_yours",
    });
  }

  await assertSeatActive(seat, seatContext);

  const issued = generateSeatToken();

  // Conditional write: if two requests race for the same legacy seat, exactly
  // one gets the token; the other must present it like everyone else.
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .update({ seat_token_hash: issued.hash, seat_token_issued_at: issued.issuedAt })
    .eq("id", seat.id)
    .is("seat_token_hash", null)
    .select("id");

  if (error) throw createError(error.message, 500, "SEAT_TOKEN_ISSUE_FAILED");

  if ((data ?? []).length === 0) {
    return tokenReject(401, "SEAT_TOKEN_MISSING", "X-Seat-Token header is required", {
      ...seatContext,
      reason: "lost_lazy_issue_race",
    });
  }

  attachIssuedToken(res, issued.token);
  logger.info({ ...seatContext, lazy: true }, "seat token issued to legacy participant");

  return { ...seat, seat_token_hash: issued.hash };
};

export const requireSeat = (options: RequireSeatOptions): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sessionId = await options.session(req);

      // Nothing resolvable to guard (bad id, unknown row, account-scoped order
      // with no table): the handler answers with its own 400/404 as before.
      if (!sessionId || !UUID.test(sessionId)) return next();

      const session = await loadSessionContext(sessionId);

      if (options.allowStaff && req.user) {
        const staff = await resolveStaff(req.user.id, session.branch_id);
        if (staff) {
          req.seatStaff = staff;
          return next();
        }
      }

      assertSessionActive(session);

      // Columns not migrated yet: behave exactly as before tokens existed.
      if (!(await seatTokenColumnsReady())) return next();

      const presented = readPresentedSeatToken(req.get(SEAT_TOKEN_HEADER));

      try {
        const seat = presented
          ? await verifyPresentedToken(req, session, presented, options.identity)
          : await lazyIssueForLegacySeat(req, res, session, options.identity);

        req.participant = toParticipant(seat);
      } catch (err) {
        // SEAT_TOKEN_ENFORCE=false: continue under the pre-token rules.
        if (err instanceof SoftReject) return next();
        throw err;
      }

      next();
    } catch (err) {
      next(err);
    }
  };

/* ------------------------------------------------------------------ */
/* Where each protected route's target session comes from.             */
/* ------------------------------------------------------------------ */

const lookupSessionId = async (table: string, id: unknown): Promise<string | null> => {
  if (typeof id !== "string" || !UUID.test(id)) return null;

  const { data, error } = await supabaseAdmin.from(table).select("session_id").eq("id", id).maybeSingle();
  if (error) throw createError(error.message, 500, "SESSION_LOOKUP_FAILED");
  return ((data as Record<string, unknown> | null)?.["session_id"] as string | null) ?? null;
};

export const sessionFromParam =
  (name: string): SessionResolver =>
  (req) =>
    (req.params as Record<string, string | undefined>)[name] ?? null;

export const sessionFromBody =
  (name: string): SessionResolver =>
  (req) => {
    const value = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof value === "string" ? value : null;
  };

export const sessionFromOrder: SessionResolver = (req) =>
  lookupSessionId("orders", (req.params as Record<string, string>)["orderId"]);

export const sessionFromSplit: SessionResolver = (req) =>
  lookupSessionId("account_splits", (req.params as Record<string, string>)["splitId"]);

export const sessionFromProposal: SessionResolver = (req) =>
  lookupSessionId("expulsion_proposals", (req.params as Record<string, string>)["proposalId"]);
