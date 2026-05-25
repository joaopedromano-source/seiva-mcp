// Shared helpers for Seiva MCP servers

export function buildHeaders(apiKey, workspaceId) {
  const h = {
    "X-Seiva-API-Key": apiKey,
    "Content-Type": "application/json",
  };
  if (workspaceId) h["X-Seiva-Workspace-Id"] = workspaceId;
  return h;
}

export function createApi(baseUrl, apiKey, getWorkspaceId) {
  return async function api(method, path, body) {
    const url = `${baseUrl}/api/v1/mgmt${path}`;
    const wsId = getWorkspaceId ? getWorkspaceId() : null;
    const opts = { method, headers: buildHeaders(apiKey, wsId) };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const json = await res.json();

    if (!res.ok) {
      const msg = json.error || (json.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`);
      // Attach the full body (incl. `classifier`, `conflict`, `errors`,
      // `warnings`, `agent_prompt`) on the Error so tools can pass the
      // structured rejection back to the agent verbatim. `err.message`
      // stays the plain string for backward compat.
      const err = new Error(msg);
      err.body = json;
      err.status = res.status;
      throw err;
    }
    return json.data;
  };
}

export function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
