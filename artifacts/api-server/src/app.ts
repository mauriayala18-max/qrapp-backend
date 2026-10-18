import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { logger } from "./lib/logger.js";
import { SEAT_TOKEN_HASH_COLUMN, SEAT_TOKEN_ISSUED_HEADER } from "./lib/seat-token.js";

const app: Express = express();

// Safety net: no response can ever carry a seat token hash, whatever query
// produced it (e.g. `session_participants(*)` embeds). Stripped at the source
// too; this catches the paths nobody remembered.
app.set("json replacer", (key: string, value: unknown) =>
  key === SEAT_TOKEN_HASH_COLUMN ? undefined : value,
);

app.use(helmet());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Seat-Token"],
    // Browsers hide response headers from JS unless they are exposed.
    exposedHeaders: [SEAT_TOKEN_ISSUED_HEADER],
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use(errorHandler);

export default app;
