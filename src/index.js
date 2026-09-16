// Entry: HTTP (/register) + WebSocket (/gserv, /wol) on one port.
const http = require("node:http");
const { WebSocketServer } = require("ws");
const accounts = require("./accounts");
const { GservServer } = require("./gserv");

const PORT = Number(process.env.PORT) || 8901;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") ?? null; // null = allow all (self-hosted lobby)

const gserv = new GservServer(accounts);

const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }
    if (req.method === "POST" && req.url?.startsWith("/register")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            let result;
            try {
                const { user, pass } = JSON.parse(body);
                result = accounts.register(user ?? "", pass ?? "");
            } catch {
                result = { error: "请求格式错误" };
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(result));
            console.log(`[register] ${JSON.stringify(result.error ? result : "ok")}`);
        });
        return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("ok");
    }
    res.writeHead(404);
    res.end("not found");
});

const wssGserv = new WebSocketServer({ noServer: true });
// WOL lobby comes in M3; refuse cleanly for now instead of hanging.
const wssWol = new WebSocketServer({ noServer: true });

wssGserv.on("connection", (ws) => gserv.handleConnection(ws));
wssWol.on("connection", (ws) => ws.close(1008, "lobby not implemented yet"));

server.on("upgrade", (req, socket, head) => {
    if (ALLOWED_ORIGINS && req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
    }
    const path = req.url?.split("?")[0];
    if (path === "/gserv" || path === "/gserv-webtransport") {
        wssGserv.handleUpgrade(req, socket, head, (ws) => wssGserv.emit("connection", ws, req));
    } else if (path === "/wol" || path === "/wol-webtransport") {
        wssWol.handleUpgrade(req, socket, head, (ws) => wssWol.emit("connection", ws, req));
    } else {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
    }
});

server.listen(PORT, () => console.log(`ra2web wol-server listening on :${PORT} (gserv: /gserv, lobby: /wol, register: POST /register)`));
