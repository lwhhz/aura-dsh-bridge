/** Aura 桥插件（DSH 进程内）：把本机会话列表暴露给 sidecar。 */
export const name = "aura-bridge";

export function apply(ctx) {
  ctx.inject(["webServer", "sessions"], (ctx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const textOf = (content) => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.map((block) => (typeof block === "string" ? block : block?.text ?? block?.content ?? "")).join("");
    };
    const roleOf = (type) => (type === "user/message" ? "user" : type === "assistant/message" ? "assistant" : type === "developer/message" ? "developer" : type === "system/message" ? "system" : "");

    const jsonText = (value, max = 4000) => {
      try { return JSON.stringify(value).slice(0, max); } catch { return String(value).slice(0, max); }
    };
    const blockText = (content, max = 4000) => {
      if (typeof content === "string") return content.slice(0, max);
      if (!Array.isArray(content)) return "";
      return content.map((b) => (typeof b === "string" ? b : b?.text ?? b?.content ?? "")).join("").slice(0, max);
    };
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/aura/detail",
      handler: (req, res) => {
        const params = new URL(req.url ?? "/", "http://local").searchParams;
        const id = params.get("id") ?? "";
        const session = ctx.sessions.list().find((item) => item.id === id);
        if (!session) { send(res, 404, { error: "not_found", id }); return; }
        const debug = params.get("debug");
        let title = "";
        const items = [];
        const callNames = new Map();
        for (const event of session.log ?? []) {
          const type = event.type ?? "";
          const data = event.data ?? {};
          if (type === "session/title") { title = data.title ?? data.text ?? title; continue; }
          if (type === "user/message") {
            const text = blockText(data.content);
            if (text) items.push({ seq: event.seq, role: "user", text });
            continue;
          }
          if (type === "assistant/message" || type === "system/message" || type === "developer/message") {
            const message = data.message ?? data;
            const blocks = Array.isArray(message.content) ? message.content : [];
            const reasoning = blocks.filter((b) => b?.type === "reasoning").map((b) => b?.text ?? "").join("").trim();
            const text = blocks.filter((b) => b?.type !== "reasoning").map((b) => b?.text ?? b?.content ?? "").join("").trim();
            if (reasoning) items.push({ seq: event.seq, role: "reasoning", text: reasoning.slice(0, 4000) });
            if (text) items.push({ seq: event.seq, role: type.split("/")[0], text });
            continue;
          }
          if (type === "tool/call") {
            const name = data.name ?? data.toolName ?? data.tool?.name ?? data.call?.name ?? "tool";
            if (data.callId) callNames.set(data.callId, String(name));
            const args = data.arguments ?? data.args ?? data.input ?? data;
            items.push({ seq: event.seq, role: "tool", name: String(name), text: jsonText(args) });
            continue;
          }
          if (type === "tool/result") {
            const text = blockText(data.message?.content) || blockText(data.content) || jsonText(data.result ?? data);
            const resultName = String(data.name ?? data.toolName ?? callNames.get(data.callId) ?? "");
            items.push({ seq: event.seq, role: "tool_result", name: resultName, text });
            continue;
          }
          if (type === "assistant/attempt" || type.includes("reasoning")) {
            const reasoning = data.reasoning_content ?? data.reasoning ?? data.message?.reasoning_content ?? "";
            if (reasoning) items.push({ seq: event.seq, role: "reasoning", text: String(reasoning).slice(0, 4000) });
          }
        }
        const trimmed = items.length > 400 ? items.slice(-400) : items;
        const debugTypes = debug === "types"
          ? Object.entries((session.log ?? []).reduce((acc, e) => { const t = e.type ?? "?"; acc[t] = (acc[t] ?? 0) + 1; return acc; }, {})).map(([type, count]) => ({ type, count }))
          : undefined;
        send(res, 200, {
          id,
          title,
          cwd: session.header?.cwd ?? "",
          eventCount: (session.log ?? []).length,
          items: trimmed,
          messages: trimmed.filter((item) => item.role === "user" || item.role === "assistant"),
          ...(debugTypes ? { types: debugTypes } : {}),
          ...(debug === "1" ? { sample: (session.log ?? []).slice(-8).map((event) => ({ type: event.type, keys: Object.keys(event.data ?? {}), data: jsonText(event.data, 300) })) } : {}),
        });
      },
    }), "aura-bridge: /aura/detail");
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/aura/sessions",
      handler: (req, res) => {
        if (req.method !== "GET") { send(res, 405, { error: "method" }); return; }
        let list = [];
        try { list = ctx.sessions.list(); } catch (error) { send(res, 500, { error: String(error) }); return; }
        send(res, 200, {
          host: "dsh",
          sessions: list.map((s) => ({
            id: s.id ?? s.sessionId ?? "",
            title: s.title ?? s.header?.title ?? s.header?.firstPrompt ?? "",
            cwd: s.cwd ?? s.header?.cwd ?? "",
            createdAt: s.createdAt ?? s.header?.createdAt ?? 0,
          })),
        });
      },
    }), "aura-bridge: /aura/sessions");
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/aura/health",
      handler: (req, res) => send(res, 200, { ok: true, plugin: "aura-bridge" }),
    }), "aura-bridge: /aura/health");
  });
}
