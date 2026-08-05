import fs from "node:fs";

const path = "/tmp/asmjs_fx_fs_streams.txt";

// createWriteStream: multiple writes + end, reported on 'finish'.
const ws = fs.createWriteStream(path);
ws.on("finish", () => {
  // createReadStream: read it back, collect 'data' chunks, report on 'end'.
  const parts = [];
  const rs = fs.createReadStream(path, { encoding: "utf8" });
  rs.on("data", (chunk) => parts.push(String(chunk)));
  rs.on("end", () => {
    console.log("content:" + parts.join(""));
    // appendFileSync must append (not overwrite).
    fs.appendFileSync(path, "!");
    console.log("appended:" + fs.readFileSync(path, "utf8"));
  });
});
ws.write("alpha ");
ws.write("beta ");
ws.end("gamma");
