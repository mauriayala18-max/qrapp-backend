---
name: QR App code-vs-schema drift
description: The live Supabase schema is authoritative and the repo has drifted from it; how to check before writing any insert.
---

The QR App backend has **no migration files and no generated types** for the
Supabase database. Large parts of the code were written against a schema that
does not exist, so inserts fail at runtime (PGRST204 / 23514) while typecheck
stays green.

**Rule:** before writing or trusting any `.from(...).insert/select` against this
database, read the live schema. Do not trust neighbouring code as a reference —
it is frequently wrong.

**Why:** whole endpoints were silently broken in production this way (payments
could not be created at all), and the failures only surface as runtime errors on
the specific request, never at build time.

**How to apply:**
- Introspect via PostgREST with the service_role key
  (`GET <SUPABASE_URL>/rest/v1/?apikey=...` returns the OpenAPI schema with every
  table's real columns).
- CHECK-constraint *values* are not in that output. Discover them with a real
  insert probe using throwaway data, read the error, then delete the probe row.
- When a fix requires a DDL change, write it to `artifacts/api-server/migrations/`
  and hand the SQL to the user: DDL cannot be executed through PostgREST, so the
  agent can never apply it.

Recurring drift pattern: the code invents extra denormalised columns
(`branch_id`, `original_amount`, `paid_by`, `created_by`, `short_name`) and
guesses the actor column name. The real tables are leaner and name the actor
after the domain role.
