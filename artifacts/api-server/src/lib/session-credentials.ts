import { randomBytes, randomInt } from "node:crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * PIN alphabet: consonants only.
 *
 * Vowels (A E I O U) are excluded so a generated PIN can never accidentally
 * spell a word in front of a customer, and Q is excluded because it reads as
 * an O on a printed table card. That leaves 20 letters:
 *
 *   B C D F G H J K L M N P R S T V W X Y Z
 *
 * 20^5 = 3.200.000 combinations, which is plenty for the PIN's real job:
 * being unique among the tables that are currently open, not being secret.
 */
export const PIN_ALPHABET = "BCDFGHJKLMNPRSTVWXYZ";
export const PIN_LENGTH = 5;

/** A 5-consonant PIN a diner can read off the table and type without mistakes. */
export const generatePin = (): string => {
  let pin = "";
  for (let i = 0; i < PIN_LENGTH; i += 1) {
    pin += PIN_ALPHABET[randomInt(0, PIN_ALPHABET.length)];
  }
  return pin;
};

/**
 * The token that travels inside the QR link. No human types it, so it is long
 * and high-entropy: 32 random bytes, URL-safe base64 (43 characters).
 */
export const generateSessionToken = (): string => randomBytes(32).toString("base64url");

/**
 * A PIN nobody else is using right now.
 *
 * Joining by PIN resolves the table through `tables.current_pin`, so two
 * tables holding the same PIN would make that lookup ambiguous. Collisions are
 * unlikely but cheap to rule out, and the alternative is a diner landing at
 * someone else's table.
 */
export const generateUniquePin = async (): Promise<string> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pin = generatePin();

    const [tableHit, sessionHit] = await Promise.all([
      supabaseAdmin.from("tables").select("id").eq("current_pin", pin).limit(1),
      supabaseAdmin
        .from("table_sessions")
        .select("id")
        .eq("pin", pin)
        .eq("status", "active")
        .limit(1),
    ]);

    if (tableHit.error || sessionHit.error) {
      throw createError(
        (tableHit.error ?? sessionHit.error)!.message,
        500,
        "PIN_LOOKUP_FAILED",
      );
    }

    // A grouped table's PIN lives on the session instead of the table, so both
    // places have to be free before the PIN can be handed out.
    if ((tableHit.data ?? []).length === 0 && (sessionHit.data ?? []).length === 0) {
      return pin;
    }
  }

  throw createError("Could not generate a free table PIN", 500, "PIN_GENERATION_FAILED");
};
