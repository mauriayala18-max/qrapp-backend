import { Router, type IRouter } from "express";

const router: IRouter = Router();

// Bump this marker whenever you need to confirm a fresh production build is
// actually live (curl /api/healthz and check `build`). The old pre-fix build
// does not include this field.
const BUILD_MARKER = "security-cancel-2026-09-08";

router.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    build: BUILD_MARKER,
    timestamp: new Date().toISOString(),
  });
});

export default router;
