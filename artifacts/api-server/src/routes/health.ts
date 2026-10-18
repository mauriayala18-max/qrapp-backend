import { Router, type IRouter } from "express";
import {
  isSeatTokenEnforced,
  seatTokenColumnsReady,
  seatTokenColumnsState,
} from "../lib/seat-token.js";

const router: IRouter = Router();

// Bump this marker whenever you need to confirm a fresh production build is
// actually live (curl /api/healthz and check `build`). The old pre-fix build
// does not include this field.
const BUILD_MARKER = "seat-token-2026-10-18";

router.get("/healthz", async (_req, res) => {
  // Cached probe (a negative answer is re-checked at most once a minute).
  await seatTokenColumnsReady().catch(() => undefined);

  res.json({
    status: "ok",
    build: BUILD_MARKER,
    // "ready" once the seat-token columns exist; "missing_columns" means the
    // SQL has not been run and tokens are neither issued nor enforced.
    seat_tokens: { columns: seatTokenColumnsState(), enforce: isSeatTokenEnforced() },
    timestamp: new Date().toISOString(),
  });
});

export default router;
