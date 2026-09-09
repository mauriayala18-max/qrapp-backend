import { createError } from "../../middleware/errorHandler.js";

/**
 * How a diner reached the table: scanning the QR (token) or typing the PIN.
 */
export type JoinMethod = "qr" | "pin";

export type AccessMethod = "qr" | "pin" | "both";

/**
 * `branches.access_method` and `table_sessions.entry_locked` are added by the
 * 20260908 migration. Until an environment runs it the columns are simply
 * absent from the row, so both readers fall back to the permissive default
 * ('both' / not locked) instead of locking every diner out of every table.
 */
export const resolveAccessMethod = (branch: Record<string, unknown> | null | undefined): AccessMethod => {
  const raw = branch?.["access_method"];
  return raw === "qr" || raw === "pin" ? raw : "both";
};

export const isEntryLocked = (session: Record<string, unknown> | null | undefined): boolean =>
  session?.["entry_locked"] === true;

/**
 * A branch that runs QR-only must not accept a typed PIN, and a branch that
 * runs PIN-only must not accept a scanned link.
 */
export const assertAccessMethodAllows = (accessMethod: AccessMethod, method: JoinMethod): void => {
  if (accessMethod === "both") return;

  if (accessMethod === "qr" && method === "pin") {
    throw createError(
      "This restaurant only accepts joining by scanning the table QR",
      403,
      "PIN_ACCESS_DISABLED",
      { access_method: accessMethod },
    );
  }

  if (accessMethod === "pin" && method === "qr") {
    throw createError(
      "This restaurant only accepts joining with the table PIN",
      403,
      "QR_ACCESS_DISABLED",
      { access_method: accessMethod },
    );
  }
};

/**
 * A locked session keeps serving the people already at the table and refuses
 * everyone else, no matter how valid their PIN or token is.
 *
 * `isKnownParticipant` must only be true for a diner the backend can actually
 * identify - an authenticated user id. A guest's typed name is not proof of
 * anything: anyone can type a name they saw on the table's participant list,
 * and that would turn the lock into a formality.
 */
export const assertEntryAllowed = (
  session: Record<string, unknown> | null | undefined,
  isKnownParticipant: boolean,
): void => {
  if (isEntryLocked(session) && !isKnownParticipant) {
    throw createError(
      "This table is not accepting new diners right now",
      403,
      "ENTRY_LOCKED",
      { session_id: session?.["id"] ?? null },
    );
  }
};
