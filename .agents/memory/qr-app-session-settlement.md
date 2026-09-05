---
name: QR App session settlement rules
description: Money semantics for closing a table, and why the balance lives in one helper.
---

**One helper owns the balance.** `computeSessionBalance(sessionId)` is the single
source of truth for what a table owes. GET session payments, session close, and
invoice creation must all call it. Never recompute a balance inline.

**Why:** the three paths previously each summed the bill their own way and
disagreed, so a table could be closed while a payer still owed money.

**Money semantics (established from the code and live data):**
- `payments.amount` stores the **net** settled amount; `discount_amount` holds the
  benefit that was subtracted from the payer's gross intent.
- A `discount`-type banking benefit is absorbed by the restaurant and counts
  toward settlement. A `reimbursement`-type one is refunded to the diner by their
  bank and must **not** count.
- `tip_amount` is a separate column and is never part of settlement.
- Guaraníes are integers everywhere; always floor/round, never carry decimals.

**Post-close invariant:** table availability is derived from the *absence* of an
active session, not from a status column on the table. So a close must leave every
freed table with zero active sessions and exactly one fresh token+PIN.

**How to apply:** PostgREST exposes no transactions, so a multi-step close cannot
be atomic. Propagate every write error and *verify* the invariant with a read
before reporting success — an unverified close reports success over half-applied
state. The durable fix is a database-side RPC that does the whole close in one
transaction.
