export async function readJsonResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

export async function postJson(url, body, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonResponse(response);
}

export async function streamNdjson(url, body, onEvent, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return readJsonResponse(response);
  if (!response.body) throw new Error("Streaming response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;

  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") result = event.req ?? event.data ?? null;
    else onEvent?.(event);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(consume);
  }
  buffer += decoder.decode();
  consume(buffer);
  return result;
}

export function createBuildApi({ apiBase = "", fetchImpl = fetch } = {}) {
  return {
    getWork: (workId) =>
      fetchImpl(`${apiBase}/api/v5/works/${workId}`).then(readJsonResponse),
    getTickets: (workId) =>
      fetchImpl(`${apiBase}/api/v5/works/${workId}/tickets`).then(
        readJsonResponse,
      ),
    post: (path, body) => postJson(`${apiBase}${path}`, body, fetchImpl),
    stream: (path, body, onEvent) =>
      streamNdjson(`${apiBase}${path}`, body, onEvent, fetchImpl),
  };
}
