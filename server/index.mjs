/** Application composition root. */
import http from "node:http";
import { createHttpHandler } from "./http/http.mjs";
import { buildRoutes, buildStreamRoutes } from "./http/build-routes.mjs";
import { projectRoutes } from "./http/project-routes.mjs";

const port = Number(process.env.PORT || 8787);
const routes = { ...projectRoutes, ...buildRoutes };
const server = http.createServer(
  createHttpHandler({ routes, streamRoutes: buildStreamRoutes }),
);
server.listen(port, () => console.log(`API http://localhost:${port}`));
