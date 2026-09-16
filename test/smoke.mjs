// Smoke test: raw gserv client that joins a game as a passive player (empty actions each turn).
// Usage: node test/smoke.mjs <gameId> <username> <password> [serverUrl]
import WebSocket from "ws";

const [gameId, user, pass] = process.argv.slice(2);
const url = process.argv[5] || "ws://127.0.0.1:8901/gserv";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const ws = new WebSocket(url);
let buffer = "";
let started = false;
let nextTurnToSend = 0; // stay a few turns ahead like a real lockstep client
const TURN_LEAD = 3;

const send = (line) => {
    console.log(">>> " + line);
    ws.send(line + "\r\n");
};
const sendBin = (buf) => ws.send(buf);

function sendEmptyActions(turnNo) {
    const out = Buffer.alloc(7);
    out[0] = 2;
    out[1] = 1;
    out.writeUInt32LE(turnNo, 2);
    out[6] = 0; // zero actions
    sendBin(out);
}

ws.on("open", () => {
    send("cvers 0.87.0 2");
    setTimeout(() => send(`user ${user} ${b64(pass)}`), 200);
    setTimeout(() => {
        send(`join ${gameId}`);
        send("loaded 100");
    }, 500);
});

ws.on("message", (data, isBinary) => {
    if (isBinary || (data instanceof Buffer && data[0] === 2)) {
        const buf = Buffer.from(data);
        if (buf[0] === 2 && buf[1] === 1) {
            // aggregated actions for a turn -> keep sending empty actions a few turns ahead
            const turnNo = buf.readUInt32LE(2);
            while (nextTurnToSend <= turnNo + TURN_LEAD) {
                sendEmptyActions(nextTurnToSend);
                nextTurnToSend++;
            }
            if (turnNo % 50 === 0) console.log(`turn ${turnNo} acked`);
        } else if (buf[0] === 2 && buf[1] === 2) {
            console.log(`<<< binary MAP_DATA (${buf.length - 2} bytes)`);
        }
        return;
    }
    buffer += data.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        console.log("<<< " + line);
        if (/ 700 /.test(line)) {
            started = true;
            console.log("*** GAME STARTED ***");
            // Kick off the lockstep: send the first few empty turns immediately.
            while (nextTurnToSend <= TURN_LEAD) {
                sendEmptyActions(nextTurnToSend);
                nextTurnToSend++;
            }
        }
        if (/ 801 /.test(line)) {
            console.log("*** DESYNC DETECTED ***");
            process.exit(1);
        }
    }
});

ws.on("error", (e) => console.error("ws error:", e.message));
ws.on("close", (code, reason) => {
    console.log(`closed (${code} ${reason})`);
    process.exit(started ? 0 : 1);
});

setTimeout(() => {
    console.log("timeout, exiting");
    process.exit(started ? 0 : 1);
}, 15 * 60 * 1000);
