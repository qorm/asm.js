const crypto = require("crypto");
const r = crypto.randomBytes(16);
const u = crypto.randomUUID();
const h = crypto.createHash("sha256").update("hello").digest("hex");
const ok = r.length === 16 && u.length === 36 && u.split("-").length === 5 && h.length === 64;
console.log(ok ? "crypto-random-ok" : "crypto-random-FAIL");
