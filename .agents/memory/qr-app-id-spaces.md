---
name: QR App actor id spaces
description: Three non-interchangeable id spaces (auth user, employees, session_participants) and the naming trap that keeps mixing them up.
---

# Three id spaces, never interchangeable

- `req.user.id` — the Supabase Auth user id. Valid only for columns that FK to `users.id`.
- `employees.id` — the staff row. Linked to auth through `employees.auth_user_id`.
- `session_participants.id` — one diner inside one table session.

**The rule:** every staff `*_by` / actor column stores `employees.id`, and diner-origin
columns (`called_by`, `generated_by`, `requested_by_participant`) store
`session_participants.id`. Run the actor through the resolvers in `src/lib/actors.ts`
before persisting it. The resolvers throw 403 on purpose — never fall back to the auth id.

**Why:** the controllers pass `req.user.id` into services under the parameter name
`employeeId`. The name lies. Reading a service in isolation gives no hint that the value
is an auth id, so the mistake reproduces every time someone adds a new `*_by` write.
Where the column has a real FK the write is rejected outright; where it does not, the row
is silently stored with a value that joins to nothing, and nobody notices for months.

**How to apply:** when adding or reviewing any write to a `*_by`, `*_employee_id`,
`actor_id`, or `attended_by`-style column, check the FK target first, then resolve. Only a
handful of columns actually carry an FK to `employees.id`, so the absence of a constraint
proves nothing about which id belongs there — decide from the column's meaning, not from
whether Postgres complains.

**Finding the FK targets:** the PostgREST OpenAPI document at `/rest/v1/` encodes them in
each column's description as `<fk table='...' column='...'/>`. Dumping that is far more
reliable than inferring relationships from the code, and it is the fastest way to audit
every actor column at once.
