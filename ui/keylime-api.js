(() => {
  const hashToken = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  if (hashToken) {
    sessionStorage.setItem("keylime.token", hashToken);
    history.replaceState(null, "", location.pathname + location.search);
  }
  const jsonHeaders = { "content-type": "application/json" };
  const rel = (time) => {
    if (!time) return "";
    const t = typeof time === "number" ? time : Date.parse(time);
    if (!Number.isFinite(t)) return String(time);
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function request(path, options = {}) {
    const headers = { ...(options.body instanceof FormData ? {} : jsonHeaders), ...(options.headers || {}) };
    const token = sessionStorage.getItem("keylime.token") || "";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...options, headers });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok || data?.ok === false) {
      const err = data?.error || { code: `HTTP_${res.status}`, message: String(data || res.statusText) };
      throw Object.assign(new Error(err.message), { code: err.code, detail: err.detail, response: data });
    }
    return data?.data ?? data;
  }
  const get = (p) => request(p);
  const post = (p, body = {}) => request(p, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body) });
  const patch = (p, body = {}) => request(p, { method: "PATCH", body: JSON.stringify(body) });
  const del = (p) => request(p, { method: "DELETE" });
  const put = (p, body = {}) => request(p, { method: "PUT", body: JSON.stringify(body) });
  const colorStatus = (status) => ({ ok: "#82a98c", success: "#82a98c", done: "#82a98c", approved: "#82a98c", running: "#b3c46e", pending: "#c9a86a", review: "#c9a86a", ask: "#c9a86a", error: "#c5897a", failed: "#c5897a", blocked: "#c5897a", rejected: "#c5897a" }[status] || "#9c968a");
  const roleFlags = (m) => ({ ...m, isUser: m.role === "user", isAgent: m.role === "agent" || m.role === "assistant", isTool: m.role === "tool", isMemory: m.role === "memory", isResearchMsg: m.role === "research", isFile: m.role === "file", isError: m.role === "error", isApproval: m.role === "approval" });
  const mapMessage = (m) => roleFlags({ id: m.id, role: m.role === "assistant" ? "agent" : m.role, text: m.content || m.text || "", html: m.html || esc(m.content || m.text || "").replace(/\n/g, "<br>"), time: rel(m.createdAt || m.time), tool: m.tool, file: m.file });
  window.KeylimeAPI = {
    request, get, post, patch, put, delete: del, rel, esc, colorStatus, mapMessage,
    async loadAll() {
      const safe = async (p, fallback) => get(p).catch(() => fallback);
      const [system, status, dashboard, chat, research, memory, graph, workspace, runs, tools, approvals, models, settings, patches] = await Promise.all([
        safe("/api/system", {}), safe("/api/status", {}), safe("/api/screens/dashboard", {}), safe("/api/chat/threads/current", { messages: [], thread: {} }), safe("/api/research", { items: [] }), safe("/api/memory", {}), safe("/api/graph", { nodes: [], edges: [] }), safe("/api/workspace", {}), safe("/api/runs", { items: [] }), safe("/api/tools", { items: [] }), safe("/api/approvals", { items: [] }), safe("/api/models", { items: [] }), safe("/api/settings", {}), safe("/api/patches", { items: [] })
      ]);
      return { system, status, dashboard, chat, research, memory, graph, workspace, runs, tools, approvals, models, settings, patches };
    },
    stream(onEvent) {
      if (!window.EventSource) return null;
      const es = new EventSource("/api/events");
      ["agent.state", "message.delta", "tool.start", "tool.finish", "approval.requested", "patch.created", "memory.updated", "research.created", "error", "cost.updated"].forEach(type => es.addEventListener(type, e => onEvent(type, JSON.parse(e.data))));
      es.onerror = () => onEvent("error", { message: "event stream disconnected" });
      return es;
    }
  };
})();
