
import type { Context, PluginDefinition } from "@yaakapp/api";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

let server: http.Server | null = null;
let port = 0;
const STORE_KEY = "api-flow:graph:v1";
let html = "";

function loadHtml() {
  try {
    // when built, canvas.html is copied alongside build/index.js -> ../src/canvas.html not available
    // so try multiple locations
    const candidates = [
      path.join(__dirname, "canvas.html"),
      path.join(__dirname, "..", "src", "canvas.html"),
      path.join(process.cwd(), "plugins", "api-flow", "src", "canvas.html"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  } catch {}
  return "<html><body>canvas.html not found</body></html>";
}

export const plugin: PluginDefinition = {
  async init(_ctx) {
    html = loadHtml();
    server = http.createServer((req, res) => {
      // patched later, this is fallback
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address() as { port: number };
        port = addr.port;
        console.log(`[api-flow] canvas http://127.0.0.1:${port}`);
        resolve();
      });
    });
  },
  async dispose() {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  },
  workspaceActions: [
    {
      label: "API Flow",
      icon: "search",
      async onSelect(ctx) {
        if (!server) await plugin.init!(ctx);
        html = loadHtml();
        const url = `http://127.0.0.1:${port}/`;
        patchServer(ctx);
        await ctx.window.openUrl({
          url,
          label: "api-flow",
          title: "API Flow",
          size: { width: 1280, height: 800 },
          onNavigate: async ({ url: _u }) => {},
          onClose: () => console.log("[api-flow] closed"),
        });
      },
    },
  ],
};

function patchServer(ctx: Context) {
  if (!server) return;
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url.pathname === "/requests") {
      try {
        const reqs = await ctx.httpRequest.list();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ requests: reqs }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }
    if (url.pathname === "/store" && req.method === "GET") {
      const v = await ctx.store.get<string>(STORE_KEY);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ graph: v ? JSON.parse(v) : null }));
      return;
    }
    if (url.pathname === "/store" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { graph } = JSON.parse(body || "{}");
          await ctx.store.set(STORE_KEY, JSON.stringify(graph));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }
    if (url.pathname === "/run" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { graph } = JSON.parse(body || "{}");
          const result = await runGraph(ctx, graph);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }
    res.writeHead(404); res.end("not found");
  });
}

async function runGraph(ctx: Context, graph: { nodes: any[]; edges: any[] }) {
  const edges = graph.edges ?? [];
  const nodes = graph.nodes ?? [];
  const incoming = new Map<string, number>();
  nodes.forEach((n: any) => incoming.set(n.id, 0));
  edges.forEach((e: any) => incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1));
  const queue = nodes.filter((n: any) => (incoming.get(n.id) ?? 0) === 0).map((n: any) => n.id);
  const visited = new Set<string>();
  const order: string[] = [];
  const adj = new Map<string, string[]>();
  edges.forEach((e: any) => { const a = adj.get(e.source) ?? []; a.push(e.target); adj.set(e.source, a); });
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id); order.push(id);
    for (const nxt of adj.get(id) ?? []) {
      incoming.set(nxt, (incoming.get(nxt) ?? 1) - 1);
      if ((incoming.get(nxt) ?? 0) === 0) queue.push(nxt);
    }
  }
  nodes.forEach((n: any) => { if (!visited.has(n.id)) order.push(n.id); });
  const out: any[] = [];
  for (const nodeId of order) {
    const node = nodes.find((n: any) => n.id === nodeId);
    if (!node?.data?.requestId) continue;
    try {
      const req = await ctx.httpRequest.getById({ id: node.data.requestId });
      if (!req) throw new Error(`request ${node.data.requestId} not found`);
      const rendered = await ctx.httpRequest.render({ httpRequest: req as any });
      const sent = await ctx.httpRequest.send({ httpRequest: rendered as any });
      const bodyText = await sent.body.text().catch(() => "(binary)");
      out.push({ nodeId, requestId: node.data.requestId, status: sent.httpResponse.status, body: bodyText.slice(0, 2000) });
    } catch (e) {
      out.push({ nodeId, error: String(e) });
    }
  }
  await ctx.toast.show({ message: `Flow ran ${out.length} requests`, color: out.some((r) => r.error) ? "warning" : "success" });
  return { order, results: out };
}
