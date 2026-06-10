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

## Module pattern
- Each module = `service.ts` -> `controller.ts` -> `routes.ts`, registered in
  `src/routes/index.ts`. Two routers can mount at the same base (e.g. both the legacy
  `routes/panel.ts` and `modules/panel/panel.routes.ts` mount at `/v1/panel`) as long as
  paths are distinct.
- Supabase JS has no GROUP BY: aggregate in JS. For parallel reads use `Promise.all` and
  check each result's `.error` to fail explicitly rather than degrade to silent zeros.
