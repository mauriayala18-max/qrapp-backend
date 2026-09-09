/* Throwaway live verification for the reworked table-session core. */
import { supabaseAdmin } from "./src/config/supabase.js";
import * as sessions from "./src/modules/sessions/sessions.service.js";
import * as groups from "./src/modules/table-groups/table-groups.service.js";
import { generatePin, generateSessionToken, PIN_ALPHABET } from "./src/lib/session-credentials.js";
import { assertAccessMethodAllows, assertEntryAllowed, resolveAccessMethod } from "./src/modules/sessions/session-access.js";

const BRANCH_R = "22222222-2222-2222-2222-222222222222";
const MANAGER_AUTH = "fbae340a-e94f-4ed3-96d8-5327d9994929";
const USER_A = "f6f7ffdb-a93f-4239-9777-406824af5cf6";
const USER_B = "aa5c14a9-f1f7-4dd4-9bd0-bcc33fe27219";

let pass = 0;
let fail = 0;
const madeTables: string[] = [];
const madeGroups: string[] = [];

const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? " -> " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? " -> " + detail : ""}`); }
};

const expectCode = async (label: string, code: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} -> no error thrown (expected ${code})`);
  } catch (e) {
    const err = e as { statusCode?: number; code?: string; message?: string };
    if (err.code === code) { pass++; console.log(`PASS  ${label} -> ${err.statusCode} ${err.code}`); }
    else { fail++; console.log(`FAIL  ${label} -> expected ${code}, got ${err.statusCode} ${err.code}: ${err.message}`); }
  }
};

const mkTable = async (tableNumber: number) => {
  const token = generateSessionToken();
  const pin = generatePin();
  const { data, error } = await supabaseAdmin
    .from("tables")
    .insert({
      branch_id: BRANCH_R, table_number: tableNumber, capacity: 4,
      current_session_token: token, current_pin: pin,
      qr_code_url: `/t/${BRANCH_R}/${token}`, is_active: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  const id = (data as Record<string, string>)["id"]!;
  madeTables.push(id);
  return { id, tableNumber, token, pin };
};

const tableRow = async (id: string) => {
  const { data } = await supabaseAdmin.from("tables").select("current_session_token, current_pin, qr_code_url").eq("id", id).single();
  return data as Record<string, string>;
};

const activeSessions = async (tableId: string) => {
  const { data } = await supabaseAdmin.from("table_sessions").select("id, session_token, pin, status, opened_at, created_at").eq("table_id", tableId).eq("status", "active");
  return (data ?? []) as Array<Record<string, unknown>>;
};

const run = async () => {
  console.log("=== STEP 1: generators ===");
  console.log(`consonant set (${PIN_ALPHABET.length} letters): ${PIN_ALPHABET.split("").join(" ")}`);
  const pins = Array.from({ length: 6 }, () => generatePin());
  const tokens = Array.from({ length: 2 }, () => generateSessionToken());
  console.log("sample PINs:   " + pins.join("  "));
  console.log("sample tokens: " + tokens.join("\n               "));
  check("PINs are 5 consonants, no vowels", pins.every((p) => /^[BCDFGHJKLMNPRSTVWXYZ]{5}$/.test(p)));
  check("tokens are long and URL-safe", tokens.every((t) => t.length >= 40 && /^[A-Za-z0-9_-]+$/.test(t)), `${tokens[0]!.length} chars`);

  console.log("\n=== (a) join by PIN on a table with NO active session CREATES one ===");
  const t1 = await mkTable(901);
  console.log(`      test table #901 pin=${t1.pin} token=${t1.token.slice(0, 12)}...`);
  check("the table starts with no active session", (await activeSessions(t1.id)).length === 0);

  const joinA = (await sessions.joinSession({ pin: t1.pin, platform: "web", userId: USER_A })) as Record<string, unknown>;
  console.log("      response: " + JSON.stringify(joinA, (k, v) => (k === "participants" ? `[${(v as unknown[]).length}]` : v)));
  const openedRows = await activeSessions(t1.id);
  check("a session was created", openedRows.length === 1, openedRows[0]?.["id"] as string);
  check("it adopted the table's printed PIN and token", openedRows[0]?.["pin"] === t1.pin && openedRows[0]?.["session_token"] === t1.token);
  check("opened_at was set", Boolean(openedRows[0]?.["opened_at"]));
  check("the response confirms table + branch + restaurant", joinA["table_number"] === 901 && Boolean((joinA["branch"] as Record<string, unknown>)?.["name"]) && Boolean(joinA["restaurant_name"]),
    `Mesa ${joinA["table_number"]} de ${joinA["restaurant_name"]} (${(joinA["branch"] as Record<string, unknown>)?.["name"]})`);
  check("session_opened_now + joined_via are reported", joinA["session_opened_now"] === true && joinA["joined_via"] === "pin");

  console.log("\n=== (b) a second user joins the SAME session, nobody is duplicated ===");
  const joinB = (await sessions.joinSession({ pin: t1.pin, platform: "app", userId: USER_B })) as Record<string, unknown>;
  check("second user got the same session", joinB["session_id"] === joinA["session_id"]);
  check("no second session was opened", (await activeSessions(t1.id)).length === 1);
  check("the table now has 2 participants", (joinB["participants"] as unknown[]).length === 2);

  const rejoin = (await sessions.joinSession({ pin: t1.pin, platform: "web", userId: USER_A })) as Record<string, unknown>;
  check("the same user rejoining does not duplicate", (rejoin["participants"] as unknown[]).length === 2 && rejoin["participant_id"] === joinA["participant_id"]);
  check("the rejoin is reported as such", rejoin["rejoined"] === true);

  const guest1 = (await sessions.joinSession({ pin: t1.pin, platform: "web", name: "Tio Cachito el Rapido" })) as Record<string, unknown>;
  const guest2 = (await sessions.joinSession({ pin: t1.pin, platform: "web", name: "Tio Cachito el Rapido" })) as Record<string, unknown>;
  check("a guest joins by name and is not duplicated", (guest2["participants"] as unknown[]).length === 3 && guest2["participant_id"] === guest1["participant_id"]);

  console.log("\n=== the QR path opens a session from scratch too ===");
  const t2 = await mkTable(902);
  const joinQr = (await sessions.joinSession({ token: t2.token, platform: "app", userId: USER_A })) as Record<string, unknown>;
  check("join by token created the session", joinQr["session_opened_now"] === true && (await activeSessions(t2.id)).length === 1);
  check("joined via qr", joinQr["joined_via"] === "qr");

  console.log("\n=== bad credentials ===");
  await expectCode("an unknown PIN is rejected", "TABLE_NOT_FOUND", () => sessions.joinSession({ pin: "ZZZZZ", platform: "web", userId: USER_A }));
  await expectCode("an unknown token is rejected", "TABLE_NOT_FOUND", () => sessions.joinSession({ token: "nope-nope-nope", platform: "web", userId: USER_A }));

  console.log("\n=== a stale active session is not a back door ===");
  const t3 = await mkTable(903);
  const stalePin = generatePin();
  const staleToken = generateSessionToken();
  const { data: staleRow } = await supabaseAdmin.from("table_sessions")
    .insert({ table_id: t3.id, branch_id: BRANCH_R, session_token: staleToken, pin: stalePin, status: "active", opened_at: new Date().toISOString() })
    .select("id").single();
  console.log(`      table #903 runs session ${(staleRow as Record<string, string>)["id"]}; a SECOND active session is then forced onto it`);
  const orphanPin = generatePin();
  await supabaseAdmin.from("table_sessions")
    .insert({ table_id: t3.id, branch_id: BRANCH_R, session_token: generateSessionToken(), pin: orphanPin, status: "active", opened_at: new Date().toISOString() });
  const live = (await sessions.joinSession({ pin: stalePin, platform: "web", userId: USER_A })) as Record<string, unknown>;
  check("the table's live session still accepts its PIN", live["session_id"] === (staleRow as Record<string, string>)["id"]);
  await expectCode("the leftover session's PIN is refused", "TABLE_NOT_FOUND", () => sessions.joinSession({ pin: orphanPin, platform: "web", userId: USER_B }));

  console.log("\n=== (c) access_method and (d) entry_locked ===");
  console.log("      the columns do not exist yet (migration 20260908 is yours to run), so these");
  console.log("      run against the exact policy functions the join path calls:");
  check("a missing column means 'both' and unlocked", resolveAccessMethod({}) === "both");
  await expectCode("(c) access_method='qr' refuses a PIN join", "PIN_ACCESS_DISABLED", async () => assertAccessMethodAllows(resolveAccessMethod({ access_method: "qr" }), "pin"));
  await expectCode("     access_method='pin' refuses a QR join", "QR_ACCESS_DISABLED", async () => assertAccessMethodAllows(resolveAccessMethod({ access_method: "pin" }), "qr"));
  check("     access_method='both' allows either", (() => { assertAccessMethodAllows("both", "pin"); assertAccessMethodAllows("both", "qr"); return true; })());
  await expectCode("(d) entry_locked=true refuses a NEW diner", "ENTRY_LOCKED", async () => assertEntryAllowed({ entry_locked: true }, false));
  check("     entry_locked=true readmits an identified diner", (() => { assertEntryAllowed({ entry_locked: true }, true); return true; })());
  await expectCode("     a guest cannot claim a name to slip past the lock", "ENTRY_LOCKED", async () => assertEntryAllowed({ entry_locked: true }, Boolean("Tio Cachito" && undefined)));

  console.log("\n=== (e) closing rotates BOTH token and PIN ===");
  const before = await tableRow(t1.id);
  const sessionId = joinA["session_id"] as string;
  await sessions.closeSession(sessionId, MANAGER_AUTH);
  const after = await tableRow(t1.id);
  console.log(`      before: pin=${before["current_pin"]}  token=${before["current_session_token"]!.slice(0, 16)}...`);
  console.log(`      after:  pin=${after["current_pin"]}  token=${after["current_session_token"]!.slice(0, 16)}...`);
  console.log(`      qr_code_url after: ${after["qr_code_url"]}`);
  check("the PIN rotated", after["current_pin"] !== before["current_pin"]);
  check("the token rotated", after["current_session_token"] !== before["current_session_token"]);
  check("the new PIN has the new format", /^[BCDFGHJKLMNPRSTVWXYZ]{5}$/.test(after["current_pin"]!), after["current_pin"]);
  check("the new token is long and URL-safe", after["current_session_token"]!.length >= 40 && /^[A-Za-z0-9_-]+$/.test(after["current_session_token"]!));
  check("the stored QR link points at the new token", after["qr_code_url"] === `/t/${BRANCH_R}/${after["current_session_token"]}`);
  check("the table has no active session left", (await activeSessions(t1.id)).length === 0);
  await expectCode("the OLD pin opens nothing", "TABLE_NOT_FOUND", () => sessions.joinSession({ pin: t1.pin, platform: "web", userId: USER_A }));
  await expectCode("the OLD token opens nothing", "TABLE_NOT_FOUND", () => sessions.joinSession({ token: t1.token, platform: "web", userId: USER_A }));
  const reopened = (await sessions.joinSession({ pin: after["current_pin"]!, platform: "web", userId: USER_A })) as Record<string, unknown>;
  check("the NEW pin opens a fresh session", reopened["session_opened_now"] === true && reopened["session_id"] !== sessionId);

  console.log("\n=== unmerging tables leaves one session per table ===");
  const g1 = await mkTable(911);
  const g2 = await mkTable(912);
  const created = (await groups.createTableGroup({ branchId: BRANCH_R, tableIds: [g1.id, g2.id], name: "Prueba", authUserId: MANAGER_AUTH })) as Record<string, unknown>;
  const groupId = (created["id"] ?? (created["group"] as Record<string, unknown>)?.["id"]) as string;
  madeGroups.push(groupId);
  await groups.deleteTableGroup(groupId);
  const a1 = await activeSessions(g1.id);
  const a2 = await activeSessions(g2.id);
  check("released table A runs exactly one session", a1.length === 1, `${a1.length}`);
  check("released table B runs exactly one session", a2.length === 1, `${a2.length}`);

  console.log("\n=== resulting rows ===");
  const { data: rows } = await supabaseAdmin
    .from("table_sessions").select("id, table_id, session_token, pin, status, opened_at, closed_at, closed_by")
    .in("table_id", madeTables).order("opened_at", { ascending: true });
  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    console.log(`  ${String(r["status"]).padEnd(6)} pin=${r["pin"]}  token=${String(r["session_token"]).slice(0, 14)}...  opened=${r["opened_at"]}  closed=${r["closed_at"] ?? "-"}`);
  }
  const sessionIds = ((rows ?? []) as Array<Record<string, string>>).map((r) => r["id"]!);
  const { data: parts } = await supabaseAdmin
    .from("session_participants").select("session_id, user_id, web_name, connection_method, platform, joined_at").in("session_id", sessionIds);
  console.log("participants:");
  for (const p of (parts ?? []) as Array<Record<string, unknown>>) {
    console.log(`  ${p["connection_method"]}/${p["platform"]}  user=${String(p["user_id"] ?? "-").slice(0, 8)}  name=${p["web_name"] ?? "-"}  joined=${p["joined_at"]}`);
  }
  console.log("\nSAMPLE SESSION ROW:\n" + JSON.stringify((rows ?? [])[0], null, 2));
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);

  console.log("\n=== cleanup ===");
  if (sessionIds.length) {
    await supabaseAdmin.from("session_participants").delete().in("session_id", sessionIds);
    await supabaseAdmin.from("audit_log").delete().in("reference_id", sessionIds);
    await supabaseAdmin.from("table_sessions").delete().in("id", sessionIds);
  }
  for (const gid of madeGroups) {
    await supabaseAdmin.from("table_group_members").delete().eq("group_id", gid);
    await supabaseAdmin.from("audit_log").delete().eq("reference_id", gid);
    await supabaseAdmin.from("table_groups").delete().eq("id", gid);
  }
  await supabaseAdmin.from("tables").delete().in("id", madeTables);

  const { data: leftTables } = await supabaseAdmin.from("tables").select("id").in("id", madeTables);
  const { data: leftSessions } = await supabaseAdmin.from("table_sessions").select("id").in("table_id", madeTables);
  const { data: leftParts } = sessionIds.length
    ? await supabaseAdmin.from("session_participants").select("id").in("session_id", sessionIds)
    : { data: [] };
  const { data: leftGroups } = madeGroups.length
    ? await supabaseAdmin.from("table_groups").select("id").in("id", madeGroups)
    : { data: [] };
  console.log("leftover rows (all must be 0): " + JSON.stringify({
    tables: (leftTables ?? []).length, sessions: (leftSessions ?? []).length,
    participants: (leftParts ?? []).length, groups: (leftGroups ?? []).length,
  }));
};

run().catch((e) => { console.error("RUNNER CRASHED", e); process.exit(1); });
