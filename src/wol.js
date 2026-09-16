// WOL lobby: IRC-style lobby for the ra2web web client.
// Protocol reference: ra2web-site/js/app.js WolConnection.
// Handles login (MOTD), lobby channels, game rooms (joingame/gameopt), and game start (startg).

const crypto = require("node:crypto");

const SERVER_NAME = "wol";
const LOBBY_CHANNEL = "#lobby";
// Public gserv URL handed to clients in STARTG. On the VPS: wss://<domain>/gserv
const GSERV_PUBLIC_URL = process.env.GSERV_PUBLIC_URL || `ws://127.0.0.1:${process.env.PORT || 8901}/gserv`;

// Reply/error codes used by the client
const C = {
    MOTD_START: 375,
    MOTD_LINE: 372,
    MOTD_END: 376,
    BAD_LOGIN: 378,
    BANNED: 465,
    SERVER_FULL: 721,
    LOGIN_QUEUE: 720,
    LIST_START: 321,
    LIST_ENTRY: 322,
    LIST_ENTRY2: 326,
    LIST_END: 323,
    NAMREPLY: 353,
    END_OF_NAMES: 366,
    SETLOCALE: 310,
    CVERS_OK: 700,
    CVERS_OUTDATED: 701,
    ROOM_CONFLICT: 400,
    BAD_PASSWORD: 475,
    ROOM_FULL: 471,
    ROOM_CLOSED: 484,
};

function escapeChannelName(name) {
    return name
        .split("")
        .map((c) =>
            c === " " ? "_" : c === "%" ? "%%" : c === "_" ? "%_" : c === ":" ? "%=" : c === "," ? "%-" : c,
        )
        .join("");
}

function unescapeChannelName(name) {
    let out = "";
    for (let i = 0; i < name.length; ) {
        const c = name[i++];
        if (c === "%") {
            const n = name[i++];
            out += n === "=" ? ":" : n === "-" ? "," : n ?? "";
        } else {
            out += c === "_" ? " " : c;
        }
    }
    return out;
}

// Description/modName fields in topics: base64 of BIG-ENDIAN UTF-16 bytes (client's utf16ToBinaryString).
const encodeDesc = (text) => {
    const buf = Buffer.from(text, "utf16le");
    for (let i = 0; i + 1 < buf.length; i += 2) {
        [buf[i], buf[i + 1]] = [buf[i + 1], buf[i]];
    }
    return buf.toString("base64");
};

class Room {
    constructor(name, host, password, isPrivate, tournament) {
        this.name = name; // unescaped, e.g. "#host's game"
        this.host = host;
        this.password = password || null;
        this.isPrivate = isPrivate;
        this.tournament = tournament;
        this.members = new Map(); // name -> client
        this.gameOpts = new Map(); // first letter of data -> latest gameopt line
        this.createdAt = Date.now();
        this.gameId = null;
    }

    broadcast(text, exceptName = null) {
        for (const [name, client] of this.members) {
            if (name !== exceptName) client.sendText(text);
        }
    }
}

class WolClientHandler {
    constructor(ws, server) {
        this.ws = ws;
        this.server = server;
        this.name = null;
        this.pendingPass = null;
        this.buffer = "";
        this.room = null; // Room this client is inside (one game room at a time)

        ws.on("message", (data) => this.onData(data));
        ws.on("close", () => this.onClose());
        ws.on("error", () => this.onClose());
    }

    sendText(text) {
        if (this.ws.readyState === 1) {
            if (process.env.WOL_DEBUG && text.includes("GAMEOPT")) {
                console.log(`[wol-out] -> ${this.name ?? "?"}: ${text.slice(0, 120)}`);
            }
            this.ws.send(text + "\r\n");
        }
    }

    reply(code, text) {
        this.sendText(`:${SERVER_NAME} ${code} ${this.name ?? "*"} ${text}`);
    }

    onData(data) {
        this.buffer += data.toString("utf8");
        let idx;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, "");
            this.buffer = this.buffer.slice(idx + 1);
            if (line.length > 0) this.onLine(line);
        }
    }

    onLine(line) {
        if (process.env.WOL_DEBUG) console.log(`[wol-in] ${this.name ?? "?"}: ${line}`);
        const parts = line.split(" ");
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        const trailingIdx = line.indexOf(" :");
        const trailing = trailingIdx >= 0 ? line.slice(trailingIdx + 2) : null;

        try {
            switch (cmd) {
                case "cvers":
                    return this.reply(C.CVERS_OK, ":ok");
                case "setlocale":
                    return this.reply(C.SETLOCALE, ":ok");
                case "pass":
                    this.pendingPass = args[0];
                    return;
                case "nick":
                    return this.onNick(args[0]);
                case "user":
                    return; // user UserName HostName irc.westwood.com :RealName — ignored
                case "join":
                    return this.onJoinChannel(unescapeChannelName(trailing ?? args[0] ?? ""));
                case "names":
                    return this.onNames(args[0]);
                case "part":
                    return this.onPart(unescapeChannelName(trailing ?? args[0] ?? ""));
                case "list":
                    return this.onList(args[0]);
                case "joingame":
                    return this.onJoingame(args);
                case "gameopt":
                    return this.onGameopt(args[0], trailing ?? "");
                case "topic":
                    return this.onTopic(args[0], trailing ?? "");
                case "mode":
                    return this.room?.broadcast(`:${this.name}!${SERVER_NAME} MODE ${args.join(" ")}`, this.name);
                case "startg":
                    return this.onStartg(args);
                case "kick":
                    return this.onKick(args);
                case "privmsg":
                case "page":
                case "notice":
                    return this.onChat(cmd, args, trailing);
                case "gping":
                    return this.room?.broadcast(`:${this.name}!${SERVER_NAME} GPING ${args.join(" ")}`, this.name);
                case "ping":
                    return this.sendText(`:${SERVER_NAME} PONG ${this.name ?? "*"} :${trailing ?? args[0] ?? ""}`);
                case "pong":
                    return;
                case "quit":
                    return this.ws.close();
                default:
                    console.warn(`[wol] unknown command from ${this.name}: ${line}`);
            }
        } catch (err) {
            console.error(`[wol] error handling "${line}":`, err.message);
        }
    }

    onNick(name) {
        if (!name) return;
        if (this.pendingPass == null) return this.reply(C.BAD_LOGIN, ":missing password");
        const pass = Buffer.from(this.pendingPass, "base64").toString("utf8");
        if (!this.server.accounts.verify(name, pass)) {
            return this.reply(C.BAD_LOGIN, ":bad login");
        }
        const existing = this.server.clientsByName.get(name);
        if (existing && existing !== this) existing.ws.close();
        this.name = name;
        this.server.clientsByName.set(name, this);
        // MOTD sequence = login success
        this.reply(C.MOTD_START, `:- ${SERVER_NAME} Message of the Day -`);
        this.reply(C.MOTD_LINE, ":- 欢迎来到自建红警联机大厅");
        this.reply(C.MOTD_END, ":End of /MOTD command.");
        console.log(`[wol] ${name} logged in`);
    }

    onJoinChannel(channel) {
        if (!this.name) return;
        // JOIN echo, then names list
        this.sendText(`:${this.name}!${SERVER_NAME} JOIN :0,0,1 ${escapeChannelName(channel)}`);
        const users =
            channel === LOBBY_CHANNEL
                ? [...this.server.clientsByName.values()].map((c) => `${c.name},0,0,0`)
                : [`${this.name},0,0,0`];
        this.sendText(`:${SERVER_NAME} ${C.NAMREPLY} ${this.name} = ${escapeChannelName(channel)} :${users.join(" ")}`);
        this.sendText(`:${SERVER_NAME} ${C.END_OF_NAMES} ${this.name} ${escapeChannelName(channel)} :End of /NAMES`);
    }

    onNames(channelArg) {
        const channel = unescapeChannelName(channelArg ?? "");
        const room = this.server.rooms.get(channel);
        const chan = escapeChannelName(channel);
        let users;
        if (room) {
            users = [...room.members.keys()].map((name) => `${name === room.host ? "@" : ""}${name},0,50,1`);
        } else if (channel === LOBBY_CHANNEL) {
            users = [...this.server.clientsByName.keys()].map((name) => `${name},0,0,0`);
        } else {
            users = [`${this.name},0,0,0`];
        }
        this.sendText(`:${SERVER_NAME} ${C.NAMREPLY} ${this.name} = ${chan} :${users.join(" ")}`);
        this.sendText(`:${SERVER_NAME} ${C.END_OF_NAMES} ${this.name} ${chan} :End of /NAMES`);
    }

    onPart(channel) {
        if (this.room && this.room.name === channel) {
            this.leaveRoom();
        }
        this.sendText(`:${this.name}!${SERVER_NAME} PART ${escapeChannelName(channel)}`);
    }

    onList(gameType) {
        this.reply(C.LIST_START, "Channels :Users Name");
        for (const room of this.server.rooms.values()) {
            if (room.isPrivate) continue;
            const chan = escapeChannelName(room.name);
            // Prefer the host-published topic (real mod hash/map/desc); fall back to a stub.
            const maxPlayers = 8;
            const topic = room.topic ?? `10${maxPlayers},0,0,0,1,,${encodeDesc(room.name)},`;
            const hostPing = 50;
            this.sendText(
                `:${SERVER_NAME} ${C.LIST_ENTRY} ${this.name} ${chan} ${room.members.size} 0 ${gameType ?? 0} ${
                    room.tournament ? 1 : 0
                } 0 ${hostPing} x::${topic} 0`,
            );
        }
        this.reply(C.LIST_END, ":End of /LIST");
    }

    onJoingame(args) {
        if (!this.name) return;
        const channel = unescapeChannelName(args[0] ?? "");
        if (!channel) return;
        const existing = this.server.rooms.get(channel);
        if (existing) {
            // Join an existing room
            if (existing.password && existing.password !== args[args.length - 1]) {
                return this.reply(C.BAD_PASSWORD, ":bad password");
            }
            if (existing.gameId) return this.reply(C.ROOM_CLOSED, ":game already started");
            existing.members.set(this.name, this);
            this.room = existing;
        } else {
            // Create a new room: joingame <chan> <?> <?> <?> <priv> 0 <tourney> 0 [pass]
            const password = args.length > 8 ? args[8] : null;
            const room = new Room(channel, this.name, password, args[4] === "1", args[6] === "1");
            room.members.set(this.name, this);
            this.server.rooms.set(channel, room);
            this.room = room;
            console.log(`[wol] ${this.name} created room "${channel}"`);
        }
        // Echo JOINGAME to every room member (client expects params[5]=ping, params[6]=fresh)
        this.room.broadcast(`:${this.name}!${SERVER_NAME} JOINGAME 0 0 0 0 0 50 1 :${escapeChannelName(channel)}`);
        // The client waits for the channel NAMES list before rendering the room screen:
        // without 353/366 the host sits on a blank "主机画面" forever.
        const chan = escapeChannelName(channel);
        const users = [...this.room.members.keys()].map((name) => {
            const prefix = name === this.room.host ? "@" : "";
            return `${prefix}${name},0,50,1`;
        });
        this.sendText(`:${SERVER_NAME} ${C.NAMREPLY} ${this.name} = ${chan} :${users.join(" ")}`);
        this.sendText(`:${SERVER_NAME} ${C.END_OF_NAMES} ${this.name} ${chan} :End of /NAMES`);
        // Replay the room's current gameopt state to the new member. Delayed: the joiner's
        // client only sets gameChannelName AFTER the joingame reply + host-wait resolves,
        // and silently drops gameopts that arrive before that (they'd lose the slot list
        // forever, since L-lines are only sent on membership changes).
        if (this.room.host !== this.name) {
            const room = this.room;
            const host = room.host;
            setTimeout(() => {
                if (this.room !== room || this.ws.readyState !== 1) return;
                for (const data of room.gameOpts.values()) {
                    this.sendText(`:${host}!${SERVER_NAME} GAMEOPT ${chan} :${data}`);
                }
            }, 1500);
        }
        console.log(`[wol] ${this.name} joined room "${channel}" (${this.room.members.size} members)`);
    }

    onGameopt(channel, data) {
        if (!this.room) return;
        const key = data[0] ?? "?";
        this.room.gameOpts.set(key, data);
        // Echo to ALL members including the sender: clients update their own UI
        // (e.g. the "接受"/ready button) only when their gameopt comes back.
        // NOTE: `channel` arrives already wire-escaped — forward verbatim, never re-escape.
        this.room.broadcast(`:${this.name}!${SERVER_NAME} GAMEOPT ${channel} :${data}`);
    }

    // Host publishes the room topic (mod hash, map, description, player counts) via a
    // dedicated "topic" command; we store it verbatim and serve it in LIST replies.
    onTopic(channel, data) {
        if (!this.room || this.room.host !== this.name) return;
        this.room.topic = data;
    }

    onStartg(args) {
        if (!this.room || this.room.host !== this.name) return;
        const room = this.room;
        room.gameId = crypto.randomUUID();
        const ts = Math.floor(Date.now() / 1000);
        // GSERV info line, then STARTG with the gserv URL and game id
        for (const [name, client] of room.members) {
            client.sendText(`:${SERVER_NAME} GSERV ${name} :gserv1 自建大厅 ${GSERV_PUBLIC_URL}`);
            client.sendText(`:${SERVER_NAME} STARTG ${this.name} :${GSERV_PUBLIC_URL} :${room.gameId} ${ts}`);
        }
        console.log(`[wol] room "${room.name}" starting game ${room.gameId} (${room.members.size} players)`);
    }

    onKick(args) {
        if (!this.room || this.room.host !== this.name) return;
        const [channel, target] = args;
        const victim = target ? this.server.clientsByName.get(target) : null;
        this.room.broadcast(`:${this.name}!${SERVER_NAME} KICK ${escapeChannelName(channel)} ${target} :kicked`);
        if (victim && victim.room === this.room) {
            this.room.members.delete(victim.name);
            victim.room = null;
        }
    }

    onChat(verb, args, trailing) {
        if (!trailing) return;
        const target = args[0] ?? "";
        const line = `:${this.name}!${SERVER_NAME} ${verb.toUpperCase()} ${target} :${trailing}`;
        if (target.startsWith("#") && this.room) {
            this.room.broadcast(line, this.name);
        } else {
            const to = this.server.clientsByName.get(target);
            if (to) to.sendText(line);
        }
    }

    leaveRoom() {
        const room = this.room;
        if (!room) return;
        room.members.delete(this.name);
        room.broadcast(`:${this.name}!${SERVER_NAME} PART ${escapeChannelName(room.name)}`);
        this.room = null;
        if (room.members.size === 0 || room.host === this.name) {
            // Host left (or room empty): close the room
            for (const [, client] of room.members) client.room = null;
            this.server.rooms.delete(room.name);
            console.log(`[wol] room "${room.name}" closed`);
        }
    }

    onClose() {
        if (this.name && this.server.clientsByName.get(this.name) === this) {
            this.server.clientsByName.delete(this.name);
        }
        this.leaveRoom();
        console.log(`[wol] ${this.name ?? "?"} disconnected`);
    }
}

class WolServer {
    constructor(accounts) {
        this.accounts = accounts;
        this.clientsByName = new Map();
        this.rooms = new Map();
    }

    handleConnection(ws) {
        new WolClientHandler(ws, this);
    }
}

module.exports = { WolServer };
