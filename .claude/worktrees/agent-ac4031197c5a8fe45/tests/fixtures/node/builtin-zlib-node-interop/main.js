// Decode buffers produced by Node's real zlib (dynamic Huffman, stored block,
// gzip/zlib containers) to prove wire-format interop with the reference impl.
import zlib from "node:zlib";
import { Buffer } from "node:buffer";

const input = "Pack my box with five dozen liquor jugs. ".repeat(4);

// Node outputs captured offline (node -e 'zlib.*Sync(...).toString("hex")').
const GZIP = "1f8b08000000000000130b484cce56c8ad5448caaf5028cf2cc95048cb2c4b5548c9af4acd53c8c92c2ccd2f52c82a4d2fd6530818388500d559606fa4000000";
const ZLIB = "789c0b484cce56c8ad5448caaf5028cf2cc95048cb2c4b5548c9af4acd53c8c92c2ccd2f52c82a4d2fd6530818388500fb883add";
const RAW = "0b484cce56c8ad5448caaf5028cf2cc95048cb2c4b5548c9af4acd53c8c92c2ccd2f52c82a4d2fd6530818388500";
const STORED = "01a4005bff5061636b206d7920626f782077697468206669766520646f7a656e206c6971756f72206a7567732e205061636b206d7920626f782077697468206669766520646f7a656e206c6971756f72206a7567732e205061636b206d7920626f782077697468206669766520646f7a656e206c6971756f72206a7567732e205061636b206d7920626f782077697468206669766520646f7a656e206c6971756f72206a7567732e20";

console.log(zlib.gunzipSync(Buffer.from(GZIP, "hex")).toString() === input);
console.log(zlib.inflateSync(Buffer.from(ZLIB, "hex")).toString() === input);
console.log(zlib.inflateRawSync(Buffer.from(RAW, "hex")).toString() === input);
console.log(zlib.inflateRawSync(Buffer.from(STORED, "hex")).toString() === input);

// unzip auto-detects gzip vs zlib containers
console.log(zlib.unzipSync(Buffer.from(GZIP, "hex")).toString() === input);
console.log(zlib.unzipSync(Buffer.from(ZLIB, "hex")).toString() === input);

// crc32 matches Node's zlib.crc32 over the same bytes
console.log(zlib.crc32(input).toString(16));
