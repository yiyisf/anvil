import { HttpError } from "./http-error.mjs";

export function matchRoute(method, pathname, table) {
  const direct = table[`${method} ${pathname}`];
  if (direct) return { handler: direct, params: {} };

  for (const [key, handler] of Object.entries(table)) {
    const [candidateMethod, pattern] = key.split(" ");
    if (candidateMethod !== method || !pattern.includes(":")) continue;
    const names = [];
    const expression = new RegExp(
      `^${pattern.replace(/:[^/]+/g, (token) => {
        names.push(token.slice(1));
        return "([^/]+)";
      })}$`,
    );
    const match = pathname.match(expression);
    if (match) {
      return {
        handler,
        params: Object.fromEntries(
          names.map((name, index) => [
            name,
            decodeURIComponent(match[index + 1]),
          ]),
        ),
      };
    }
  }
  return null;
}

export function parseJsonBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new HttpError(400, "body too large"));
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "invalid json"));
      }
    });
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

function sendNdjson(response, event) {
  response.write(`${JSON.stringify(event)}\n`);
}

export function createHttpHandler({
  routes,
  streamRoutes = {},
  onError = console.error,
}) {
  return async function handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const query = Object.fromEntries(url.searchParams.entries());
    try {
      const streamMatch = matchRoute(
        request.method,
        url.pathname,
        streamRoutes,
      );
      if (streamMatch) {
        const body =
          request.method === "POST" ? await parseJsonBody(request) : {};
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache",
        });
        const emit = (event) => sendNdjson(response, event);
        try {
          const data = await streamMatch.handler({
            q: { ...query, ...streamMatch.params },
            body,
            emit,
          });
          sendNdjson(response, { type: "done", req: data });
        } catch (error) {
          sendNdjson(response, { type: "error", message: error.message });
        }
        return response.end();
      }

      const match = matchRoute(request.method, url.pathname, routes);
      if (!match) return sendJson(response, 404, { error: "not found" });
      const body =
        request.method === "POST" ? await parseJsonBody(request) : {};
      const data = await match.handler({
        q: { ...query, ...match.params },
        body,
      });
      return sendJson(response, 200, data);
    } catch (error) {
      if (!(error instanceof HttpError)) onError(error);
      return sendJson(
        response,
        error instanceof HttpError ? error.status : 500,
        {
          error: error.message,
        },
      );
    }
  };
}
