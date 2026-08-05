import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const b = crypto.randomBytes(16);
console.log(b.length);
console.log(Buffer.isBuffer(b));

const u = crypto.randomUUID();
console.log(u.length);
console.log(u.charAt(14));
console.log(u.charAt(8) + u.charAt(13) + u.charAt(18) + u.charAt(23));
console.log(u !== crypto.randomUUID());

const r = crypto.randomInt(100);
console.log(r >= 0 && r < 100);

console.log(crypto.createHmac("sha256", "key").update("data").digest("hex").length);
