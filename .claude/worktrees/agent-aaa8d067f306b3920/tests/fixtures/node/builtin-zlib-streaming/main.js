// zlib streaming (Transform-style) classes on top of the sync codecs:
// createGzip/createGunzip/createDeflate/createInflate emit their result as a
// 'data' chunk + 'end' (fully synchronous), and pipe() forwards into a
// writable. Verified by round-tripping through the paired stream and by a
// gzip stream piped into a collector sink.
import zlib from "node:zlib";

const src = "Streaming zlib test payload. ".repeat(8);

const gz = zlib.createGzip();
let compressed = null;
gz.on("data", (d) => { compressed = d; });
gz.on("end", () => {
    const gun = zlib.createGunzip();
    let out = "";
    gun.on("data", (d) => { out += d.toString(); });
    gun.on("end", () => {
        console.log("gzip-roundtrip: " + (out === src ? "OK" : "FAIL"));

        // Deflate/inflate with multiple write() calls before end().
        const df = zlib.createDeflate();
        let dfout = null;
        df.on("data", (d) => { dfout = d; });
        df.on("end", () => {
            const inf = zlib.createInflate();
            let s = "";
            inf.on("data", (d) => { s += d.toString(); });
            inf.on("end", () => {
                console.log("deflate-roundtrip: " + (s === src ? "OK" : "FAIL"));
                console.log("deflate-is-gzip: " + (dfout[0] === 0x1f && dfout[1] === 0x8b ? "yes" : "no"));

                // pipe() a gzip stream into a collector sink, then verify.
                const sink = { chunks: [], write(d) { this.chunks.push(d); return true; }, end() { this.done = true; } };
                const gz2 = zlib.createGzip();
                gz2.pipe(sink);
                gz2.end("pipe payload");
                console.log("pipe-chunks: " + sink.chunks.length + " done: " + (sink.done ? "yes" : "no"));
                console.log("pipe-verify: " + (zlib.gunzipSync(sink.chunks[0]).toString() === "pipe payload" ? "OK" : "FAIL"));
            });
            inf.end(dfout);
        });
        df.write("Streaming zlib test payload. ".repeat(4));
        df.write("Streaming zlib test payload. ".repeat(4));
        df.end();
    });
    gun.end(compressed);
});
gz.end(src);
