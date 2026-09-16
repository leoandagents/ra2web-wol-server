// Shared account store: JSON file, salted SHA-256. WOL lobby and gserv share these accounts.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const DB_PATH = process.env.ACCOUNTS_PATH || path.join(__dirname, "..", "accounts.json");

let db = { users: {} };
try {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
} catch {
    // first run, empty db
}

function save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function hash(pass, salt) {
    return crypto.createHash("sha256").update(salt + ":" + pass).digest("hex");
}

const NAME_RE = /^[A-Za-z0-9_\-一-鿿]{1,24}$/;

function register(user, pass) {
    if (!NAME_RE.test(user)) return { error: "用户名只能包含字母、数字、_、- 或中文，最长24字符" };
    if (!pass || pass.length < 4) return { error: "密码至少4位" };
    const key = user.toLowerCase();
    if (db.users[key]) return { error: "用户名已被注册" };
    const salt = crypto.randomBytes(8).toString("hex");
    db.users[key] = { name: user, salt, hash: hash(pass, salt), createdAt: Date.now() };
    save();
    return {};
}

function verify(user, pass) {
    const entry = db.users[user.toLowerCase()];
    if (!entry) return false;
    return entry.hash === hash(pass, entry.salt);
}

module.exports = { register, verify };
