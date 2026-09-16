// gserv: game instance relay for the ChronoDivide/ra2web client.
// Protocol reference: @chronodivide/game-api dist (GservConnection) — IRC-style text lines
// plus binary frames [2][subcmd][...]. The server is a dumb lockstep relay: it aggregates
// each network turn's actions from all players and broadcasts them back.

const SERVER_NAME = "gserv";

// Reply codes (must match the client constants)
const RPL = {
    CVERS_OK: 10,
    LOGGED_IN: 100,
    ALREADY_LOGGED_IN: 101,
    NOT_LOGGED_IN: 102,
    BAD_LOGIN: 103,
    TOO_MANY_LOGIN_ATTEMPTS: 104,
    INSTANCE_CREATED: 200,
    INSTANCE_EXISTS: 201,
    INSTANCE_TOO_MANY: 202,
    NOT_ENOUGH_PARAMS: 300,
    INVALID_PARAMS: 301,
    INSTANCE_CONNECTED: 400,
    INSTANCE_NONEXISTENT: 401,
    INSTANCE_NOT_ALLOWED: 402,
    INSTANCE_ALREADY_STARTED: 403,
    NO_INSTANCE: 404,
    INSTANCE_NOT_RUNNING: 405,
    INSTANCE_VERS_MISMATCH: 406,
    GAME_OPTS: 500,
    LOAD_INFO: 600,
    MAP_TOO_BIG: 602,
    MAP_ALREADY_SENT: 603,
    GAME_START: 700,
    GAME_DESYNC: 801,
    NET_RATE: 802,
    TAUNT: 803,
    PLAYER_DISCONNECT: 804,
};
const BIN_PREFIX = 2;
const BIN_GAME_ACTIONS = 1;
const BIN_MAP_DATA = 2;
const BIN_GAME_STATE_HASH = 2; // request subcmd
const BIN_PUT_MAP = 3;
const BIN_GET_MAP = 4;

// Default network-turn pacing broadcast at game start (millis per network turn).
const DEFAULT_NET_RATE = Number(process.env.GSERV_NET_RATE) || 50;

// Extract expected human player names from a serialized game-opts string:
// "<fields>:<name,country,color,startPos,team,0,0,0 ...>:@:<aiOpts>," (8 fields per player).
function parseExpectedPlayers(optsString) {
    const firstColon = optsString.indexOf(":");
    const atMarker = optsString.indexOf(":@:");
    if (firstColon < 0 || atMarker < 0 || atMarker <= firstColon) return [];
    const fields = optsString.slice(firstColon + 1, atMarker).split(",");
    const names = [];
    for (let i = 0; i + 7 <= fields.length - 1; i += 8) {
        if (fields[i]) names.push(fields[i]);
    }
    return names;
}

class Instance {
    constructor(id, optsString, engineVer, modHash, isPrivate, creator) {
        this.id = id;
        this.optsString = optsString;
        this.engineVer = engineVer;
        this.modHash = modHash;
        this.isPrivate = isPrivate;
        this.createdAt = Date.now();
        this.expectedNames = parseExpectedPlayers(optsString);
        this.clients = new Map(); // name -> client
        this.slotByName = new Map(); // name -> slot (join order)
        this.mapData = null; // Uint8Array | null (custom map)
        this.loadedPct = new Map(); // name -> pct
        this.started = false;
        this.turns = new Map(); // turnNo -> Map<slot, Buffer>
        this.hashes = new Map(); // turnNo -> Map<slot, hash>
        this.currentTurn = 0;
    }

    nextSlot() {
        let slot = 0;
        while ([...this.slotByName.values()].includes(slot)) slot++;
        return slot;
    }

    broadcast(text) {
        for (const client of this.clients.values()) client.sendText(text);
    }

    broadcastBinary(buf) {
        for (const client of this.clients.values()) client.sendBinary(buf);
    }
}

class GservClient {
    constructor(ws, server) {
        this.ws = ws;
        this.server = server;
        this.name = null;
        this.instance = null;
        this.textBuffer = "";
        this.alive = true;

        ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
        ws.on("close", () => this.onClose());
        ws.on("error", () => this.onClose());
    }

    sendText(text) {
        if (this.ws.readyState === 1) this.ws.send(text + "\r\n");
    }

    sendBinary(buf) {
        if (this.ws.readyState === 1) this.ws.send(buf);
    }

    reply(code, text) {
        this.sendText(`:${SERVER_NAME} ${code} ${this.name ?? "*"} :${text}`);
    }

    onMessage(data, isBinary) {
        if (isBinary || data instanceof Buffer) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (buf.length > 0 && buf[0] === BIN_PREFIX) return this.onBinary(buf);
        }
        this.textBuffer += data.toString("utf8");
        let idx;
        while ((idx = this.textBuffer.indexOf("\n")) >= 0) {
            const line = this.textBuffer.slice(0, idx).replace(/\r$/, "");
            this.textBuffer = this.textBuffer.slice(idx + 1);
            if (line.length > 0) this.onTextLine(line);
        }
    }

    onTextLine(line) {
        const parts = line.split(" ");
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        const trailingIdx = line.indexOf(" :");
        const trailing = trailingIdx >= 0 ? line.slice(trailingIdx + 2) : null;

        try {
            switch (cmd) {
                case "cvers": // cvers <engineVer> <apiVer>
                    return this.reply(RPL.CVERS_OK, "");
                case "user": // user <name> <base64pass>
                    return this.onLogin(args);
                case "create": // create <gameId> <unixTs> <opts> <engineVer> <modHash> <priv>
                    return this.onCreate(args);
                case "join": // join <gameId> <engineVer> <modHash>
                    return this.onJoin(args);
                case "gameopts":
                    return this.instance ? this.reply(RPL.GAME_OPTS, this.instance.optsString) : this.reply(RPL.NO_INSTANCE, "no instance");
                case "loaded":
                    return this.onLoaded(Number(args[0]));
                case "loadinfo":
                    return this.onLoadInfo();
                case "active":
                    return this.onActive(args[0] === "1");
                case "taunt":
                    return this.instance?.broadcast(`:${this.name} ${RPL.TAUNT} ${this.name} :${args[0] ?? ""}`);
                case "privmsg":
                    return this.onPrivmsg(args, trailing);
                case "ping":
                    return this.sendText(`:${SERVER_NAME} PONG ${this.name ?? "*"} :${trailing ?? args[0] ?? ""}`);
                case "pong":
                    return; // reply to our ping; nothing to do (could track latency)
                default:
                    console.warn(`[gserv] unknown command from ${this.name}: ${line}`);
            }
        } catch (err) {
            console.error(`[gserv] error handling "${line}":`, err.message);
        }
    }

    onLogin(args) {
        const [name, b64pass] = args;
        if (!name || !b64pass) return this.reply(RPL.NOT_ENOUGH_PARAMS, "user <name> <pass>");
        if (this.name) return this.reply(RPL.ALREADY_LOGGED_IN, "already logged in");
        let pass;
        try {
            pass = Buffer.from(b64pass, "base64").toString("utf8");
        } catch {
            return this.reply(RPL.BAD_LOGIN, "bad encoding");
        }
        if (!this.server.accounts.verify(name, pass)) {
            return this.reply(RPL.BAD_LOGIN, "bad login");
        }
        // Kick an existing connection with the same name
        const existing = this.server.clientsByName.get(name);
        if (existing && existing !== this) existing.ws.close();
        this.name = name;
        this.server.clientsByName.set(name, this);
        this.reply(RPL.LOGGED_IN, "logged in");
        console.log(`[gserv] ${name} logged in`);
    }

    onCreate(args) {
        if (!this.name) return this.reply(RPL.NOT_LOGGED_IN, "login first");
        const [gameId, ts, opts, engineVer, modHash, priv] = args;
        if (!gameId || !opts || !engineVer || !modHash) return this.reply(RPL.NOT_ENOUGH_PARAMS, "create <id> <ts> <opts> <ver> <hash> <priv>");
        if (this.server.instances.has(gameId)) return this.reply(RPL.INSTANCE_EXISTS, "game id exists");
        if (this.instance) this.leaveInstance();
        const inst = new Instance(gameId, opts, engineVer, modHash, priv === "1", this);
        this.server.instances.set(gameId, inst);
        this.joinInstance(inst);
        this.reply(RPL.INSTANCE_CREATED, "created");
        console.log(`[gserv] ${this.name} created game ${gameId}`);
    }

    onJoin(args) {
        if (!this.name) return this.reply(RPL.NOT_LOGGED_IN, "login first");
        const [gameId, engineVer, modHash] = args;
        const inst = this.server.instances.get(gameId);
        if (!inst) return this.reply(RPL.INSTANCE_NONEXISTENT, "no such game");
        // Reconnect path: a member rejoining their running game replaces their connection.
        const isMember = inst.slotByName.has(this.name);
        if (inst.started && !isMember) return this.reply(RPL.INSTANCE_ALREADY_STARTED, "game already started");
        // Only players listed in the game options may join (when the list is known).
        if (!isMember && inst.expectedNames.length > 0 && !inst.expectedNames.includes(this.name)) {
            return this.reply(RPL.INSTANCE_NOT_ALLOWED, "player not in this game");
        }
        if (engineVer && engineVer !== inst.engineVer) return this.reply(RPL.INSTANCE_VERS_MISMATCH, "version mismatch");
        if (modHash && modHash !== inst.modHash) return this.reply(RPL.INSTANCE_VERS_MISMATCH, "mod hash mismatch");
        const existing = inst.clients.get(this.name);
        if (existing && existing !== this) existing.ws.close();
        this.joinInstance(inst, isMember);
        this.reply(RPL.INSTANCE_CONNECTED, "connected");
        console.log(`[gserv] ${this.name} joined game ${gameId}${inst.started ? " (reconnect)" : ""}`);
    }

    joinInstance(inst, keepSlot = false) {
        this.instance = inst;
        inst.clients.set(this.name, this);
        if (!keepSlot) inst.slotByName.set(this.name, inst.nextSlot());
    }

    leaveInstance() {
        const inst = this.instance;
        if (!inst) return;
        inst.clients.delete(this.name);
        // Do not free the slot: the relay and reconnect logic key on it.
        this.instance = null;
        if (inst.clients.size === 0) {
            this.server.instances.delete(inst.id);
            console.log(`[gserv] game ${inst.id} closed (empty)`);
        } else if (inst.started) {
            inst.broadcast(`:${SERVER_NAME} ${RPL.PLAYER_DISCONNECT} ${this.name} :${this.name}`);
        }
    }

    onLoaded(pct) {
        if (!this.instance || Number.isNaN(pct)) return;
        this.instance.loadedPct.set(this.name, pct);
        // Start only when every EXPECTED player (from the game options) has joined and loaded 100%.
        const inst = this.instance;
        const expected = inst.expectedNames.length > 0 ? inst.expectedNames : [...inst.clients.keys()];
        const allReady = expected.every((n) => inst.clients.has(n) && (inst.loadedPct.get(n) ?? 0) >= 100);
        if (!inst.started && allReady) {
            inst.started = true;
            inst.currentTurn = 0;
            for (const client of inst.clients.values()) {
                client.sendText(`:${SERVER_NAME} ${RPL.GAME_START} ${client.name}`);
                // Initial rate broadcast (turnNo 0 applies immediately on the client).
                client.sendText(`:${SERVER_NAME} ${RPL.NET_RATE} ${client.name} :${DEFAULT_NET_RATE},0`);
            }
            console.log(`[gserv] game ${inst.id} started (${inst.clients.size} players, expected ${expected.length})`);
        }
    }

    onLoadInfo() {
        if (!this.instance) return this.reply(RPL.NO_INSTANCE, "no instance");
        const inst = this.instance;
        const info = [...inst.clients.keys()].map((n) => `${n}:${inst.loadedPct.get(n) ?? 0}`).join(",");
        this.reply(RPL.LOAD_INFO, info);
    }

    onActive(active) {
        if (!this.instance?.started) return;
        this.inactive = !active;
        this.instance.broadcast(`:${SERVER_NAME} ${RPL.PLAYER_DISCONNECT} ${this.name} :${this.name}`);
        if (active) this.tryRelayTurn(this.instance.currentTurn);
    }

    onPrivmsg(args, trailing) {
        if (!this.instance || !trailing) return;
        const targets = (args[0] ?? "").split(",");
        const from = this.name;
        for (const client of this.instance.clients.values()) {
            if (client.name === from) continue;
            if (targets.includes("#all") || targets.includes(client.name) || targets.includes("#team")) {
                client.sendText(`:${from} PRIVMSG ${client.name} :${trailing}`);
            }
        }
    }

    onBinary(buf) {
        if (!this.instance) return;
        const sub = buf[1];
        switch (sub) {
            case BIN_GAME_ACTIONS: {
                const turnNo = buf.readUInt32LE(2);
                const payload = buf.subarray(6);
                return this.onActions(turnNo, payload);
            }
            case BIN_GAME_STATE_HASH: {
                const turnNo = buf.readUInt32LE(2);
                const hash = buf.readUInt32LE(6);
                return this.onStateHash(turnNo, hash);
            }
            case BIN_PUT_MAP: {
                const inst = this.instance;
                if (inst.mapData) return this.reply(RPL.MAP_ALREADY_SENT, "map already sent");
                if (buf.length > 4 * 1024 * 1024) return this.reply(RPL.MAP_TOO_BIG, "map too big");
                inst.mapData = buf.subarray(2);
                console.log(`[gserv] map received for game ${inst.id} (${inst.mapData.length} bytes)`);
                return;
            }
            case BIN_GET_MAP: {
                const inst = this.instance;
                if (!inst.mapData) return; // official map: nothing to send
                const out = Buffer.concat([Buffer.from([BIN_PREFIX, BIN_MAP_DATA]), inst.mapData]);
                return this.sendBinary(out);
            }
            default:
                console.warn(`[gserv] unknown binary subcmd ${sub} from ${this.name}`);
        }
    }

    onActions(turnNo, payload) {
        const inst = this.instance;
        if (!inst.started) return;
        const slot = inst.slotByName.get(this.name);
        if (slot === undefined) return;
        let turn = inst.turns.get(turnNo);
        if (!turn) {
            turn = new Map();
            inst.turns.set(turnNo, turn);
        }
        if (!turn.has(slot)) turn.set(slot, payload);
        if (turnNo >= inst.currentTurn) {
            inst.currentTurn = turnNo;
            this.tryRelayTurn(turnNo);
        }
        // GC old turns
        for (const old of inst.turns.keys()) {
            if (old < inst.currentTurn - 10) inst.turns.delete(old);
        }
    }

    tryRelayTurn(turnNo) {
        const inst = this.instance;
        const turn = inst.turns.get(turnNo);
        if (!turn) return;
        // Wait for every connected, non-inactive player's actions for this turn.
        for (const [name, client] of inst.clients) {
            if (client.inactive) continue;
            const slot = inst.slotByName.get(name);
            if (!turn.has(slot)) return; // still waiting
        }
        // Aggregate in slot order: [2][1][turn:u32][count {slot,len,payload}...]
        const entries = [...turn.entries()].sort((a, b) => a[0] - b[0]);
        const head = Buffer.alloc(7);
        head[0] = BIN_PREFIX;
        head[1] = BIN_GAME_ACTIONS;
        head.writeUInt32LE(turnNo, 2);
        head[6] = entries.length;
        const parts = [head];
        for (const [slot, payload] of entries) {
            const meta = Buffer.alloc(3);
            meta[0] = slot;
            meta.writeUInt16LE(payload.length, 1);
            parts.push(meta, payload);
        }
        inst.broadcastBinary(Buffer.concat(parts));
        inst.turns.delete(turnNo);
        inst.currentTurn = turnNo + 1;
        this.tryRelayTurn(inst.currentTurn); // flush buffered future turns
    }

    onStateHash(turnNo, hash) {
        const inst = this.instance;
        if (!inst.started) return;
        let turn = inst.hashes.get(turnNo);
        if (!turn) {
            turn = new Map();
            inst.hashes.set(turnNo, turn);
        }
        turn.set(this.name, hash);
        // Compare once everyone reported; desync (801) to all on mismatch.
        if (turn.size >= inst.clients.size) {
            const values = new Set(turn.values());
            if (values.size > 1) {
                console.error(`[gserv] DESYNC in game ${inst.id} at turn ${turnNo}: ${JSON.stringify([...turn])}`);
                inst.broadcast(`:${SERVER_NAME} ${RPL.GAME_DESYNC} ${this.name}`);
            }
            inst.hashes.delete(turnNo);
        }
    }

    onClose() {
        if (!this.alive) return;
        this.alive = false;
        if (this.name && this.server.clientsByName.get(this.name) === this) {
            this.server.clientsByName.delete(this.name);
        }
        this.leaveInstance();
        console.log(`[gserv] ${this.name ?? "?"} disconnected`);
    }
}

class GservServer {
    constructor(accounts) {
        this.accounts = accounts;
        this.clientsByName = new Map();
        this.instances = new Map();
    }

    handleConnection(ws) {
        new GservClient(ws, this);
    }
}

module.exports = { GservServer };
