// Game recorder: writes every game flowing through gserv to recordings/<gameId>.jsonl
// (one JSON object per line). Enable with GSERV_RECORD=1.
const fs = require("node:fs");
const path = require("node:path");

const ENABLED = process.env.GSERV_RECORD === "1";
const DIR = process.env.GSERV_RECORD_DIR || path.join(__dirname, "..", "recordings");

class GameRecorder {
    constructor(gameId, meta) {
        this.file = path.join(DIR, `${gameId}.jsonl`);
        fs.mkdirSync(DIR, { recursive: true });
        this.stream = fs.createWriteStream(this.file, { flags: "w" });
        this.write({ t: "create", ...meta });
    }

    write(obj) {
        if (this.stream.writable) this.stream.write(JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
    }

    close(reason) {
        this.write({ t: "end", reason });
        this.stream.end();
    }
}

class RecorderManager {
    constructor() {
        this.recorders = new Map(); // gameId -> GameRecorder
        if (ENABLED) console.log(`[recorder] enabled, writing to ${DIR}`);
    }

    enabled() {
        return ENABLED;
    }

    start(gameId, meta) {
        if (!ENABLED) return;
        this.recorders.set(gameId, new GameRecorder(gameId, meta));
    }

    write(gameId, obj) {
        this.recorders.get(gameId)?.write(obj);
    }

    end(gameId, reason) {
        const r = this.recorders.get(gameId);
        if (!r) return;
        r.close(reason);
        this.recorders.delete(gameId);
        console.log(`[recorder] game ${gameId} saved (${reason})`);
    }
}

module.exports = { RecorderManager };
