---
name: QR App Supabase backend conventions
description: Durable gotchas and conventions for the QR App restaurant API (artifacts/api-server) on external Supabase.
---

# QR App API server (artifacts/api-server)

## Service-role table grants
- The Supabase `service_role` key (`supabaseAdmin`) returns `permission denied for table`
  for several tables (e.g. `restaurant_alerts`, `employees`, `employee_branches`,
  `branch_hours`, `branch_photos`, `branch_payment_methods`, `audit_log`,
  `table_waiter_assignments`) when queried out-of-band.
- **Why:** These tables lack a Postgres GRANT to `service_role` (service_role normally
  bypasses RLS, so this is a grant-level issue, not RLS). It is the user's Supabase
  configuration, not the app code.
- **How to apply:** If panel/employee endpoints fail at runtime with "permission denied",
  the fix is on the Supabase side (grant service_role access), not in the API code. All
  modules use the same `supabaseAdmin` pattern, so this affects them uniformly.

## Role-based authorization
- `requireEmployee` (middleware/employee.ts) only verifies an *active* employee by
  `user_id` and sets `req.user.role`; it does NOT gate by specific role.
- For per-endpoint role gating (admin vs admin/manager), use `requireRole(...roles)` in
  `middleware/roles.ts`, placed AFTER `requireEmployee` in the route chain.
- **Why:** The panel spec differentiates admin-only vs admin/manager vs any-employee
  endpoints, which the base middleware doesn't enforce.

## Shared client auth contamination (critical)
- `supabase-js` mutates a client's in-memory Authorization header when you call
  `auth.getUser(token)`, `auth.signInWithPassword`, or `auth.signInWithIdToken`. After
  such a call on a client, its subsequent `.from()` queries run AS THAT USER (RLS-bound),
  NOT as service-role — silently returning empty result sets once RLS is enforced.
- **Why:** This caused PIN session join to return TABLE_NOT_FOUND in prod: middleware
  verified the token via `supabaseAdmin.auth.getUser`, contaminating the singleton, so the
  later service-role `.from("table_sessions")` query was RLS-filtered to nothing.
- **How to apply:** Keep a dedicated `supabaseAuth` client (anon key, persistSession:false)
  for ALL `.auth.getUser/signInWith*` calls; never run those on `supabaseAdmin`. Reserve
  `supabaseAdmin` for `.from()` data queries and `auth.admin.*` (the admin API uses the
  service key explicitly and does NOT mutate session state, so it's safe to keep there).
  `persistSession:false` alone does NOT prevent the in-memory header mutation — only a
  separate client instance isolates it.

## Dev and prod share the same external Supabase
- The development workflow and the autoscale production deployment use the SAME
  Supabase secrets (SUPABASE_URL / ANON / SERVICE_ROLE are identical across the dev and
  prod env sets) and therefore the SAME external database.
- **Why it matters:** Identical code must behave identically in dev and prod. If a fix
  works locally but prod still shows the old behavior, it is NOT an env/RLS difference —
  prod is serving a STALE build. Verify with `listDeploymentBuilds`: compare the latest
  build's timestamp against when the fix was committed. No build after the fix = the user
  never completed a fresh publish; republishing is the fix (the build/run config is fine).
- `/api/healthz` exposes a `build` marker field for confirming a fresh build is live.

## Module pattern
- Each module = `service.ts` -> `controller.ts` -> `routes.ts`, registered in
  `src/routes/index.ts`. Two routers can mount at the same base (e.g. both the legacy
  `routes/panel.ts` and `modules/panel/panel.routes.ts` mount at `/v1/panel`) as long as
  paths are distinct.
- Supabase JS has no GROUP BY: aggregate in JS. For parallel reads use `Promise.all` and
  check each result's `.error` to fail explicitly rather than degrade to silent zeros.
