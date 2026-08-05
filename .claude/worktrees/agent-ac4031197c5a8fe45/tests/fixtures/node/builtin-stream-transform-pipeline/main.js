import { Transform, PassThrough, Readable, Writable, pipeline } from "node:stream";

// Uppercasing Transform with a flush suffix, piped into a collector.
const up = new Transform({
  transform(chunk, enc, cb) { cb(null, String(chunk).toUpperCase()); },
  flush(cb) { cb(null, "!"); },
});
const out = [];
const sink = new Writable({ write(c, e, cb) { out.push(String(c)); cb(); } });
sink.on("finish", () => {
  console.log("transform:" + out.join(""));

  // A full pipeline: array source -> PassThrough -> collector.
  const seen = [];
  pipeline(
    Readable.from(["x", "y", "z"]),
    new PassThrough(),
    new Writable({ write(c, e, cb) { seen.push(String(c)); cb(); } }),
    (err) => { console.log("pipeline:" + (err ? "ERR" : "") + seen.join("")); }
  );
});
up.pipe(sink);
up.write("ab");
up.write("cd");
up.end();
