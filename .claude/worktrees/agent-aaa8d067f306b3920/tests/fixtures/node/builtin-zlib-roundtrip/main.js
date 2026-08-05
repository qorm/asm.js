import zlib from "node:zlib";
import { Buffer } from "node:buffer";

const input = "The quick brown fox jumps over the lazy dog. ".repeat(6);
const buf = Buffer.from(input);

// raw DEFLATE round-trip + real compression
const raw = zlib.deflateRawSync(buf);
console.log(zlib.inflateRawSync(raw).toString() === input);
console.log(raw.length < buf.length);

// zlib (RFC1950) round-trip + header bytes (0x78 0x9c)
const z = zlib.deflateSync(buf);
console.log(zlib.inflateSync(z).toString() === input);
console.log(z.data[0] + "," + z.data[1]);

// gzip (RFC1952) round-trip + magic (0x1f 0x8b 0x08)
const g = zlib.gzipSync(buf);
console.log(zlib.gunzipSync(g).toString() === input);
console.log(g.data[0] + "," + g.data[1] + "," + g.data[2]);

// checksums
console.log(zlib.crc32("abc").toString(16));
console.log(zlib.crc32("hello world").toString(16));

// binary data round-trip
const binArr = [];
for (let i = 0; i < 200; i++) binArr.push((i * 37 + 11) & 0xff);
const bin = Buffer.from(binArr);
const bz = zlib.gunzipSync(zlib.gzipSync(bin));
let same = bz.length === binArr.length;
for (let i = 0; i < binArr.length; i++) { if (bz.data[i] !== binArr[i]) same = false; }
console.log(same);
