// HTTP/1.1 chunked transfer-encoding in both directions over the async net
// layer: the client streams a chunked request body (Transfer-Encoding: chunked,
// multiple write()s), the server decodes it, and the server streams a chunked
// response via res.write() without a Content-Length (auto-chunked), which the
// client decodes back into the full body.
import http from "node:http";

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
        // No Content-Length + streaming writes => chunked response framing.
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("recv[" + body + "]");
        res.write(" method=" + req.method);
        res.write(" te=" + (req.headers["transfer-encoding"] || "none"));
        res.end();
    });
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const req = http.request({
    host: "127.0.0.1", port: port, method: "PUT", path: "/stream",
    headers: { "Transfer-Encoding": "chunked" },
}, (res) => {
    console.log("status " + res.statusCode);
    console.log("resp-te " + (res.headers["transfer-encoding"] || "none"));
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
        console.log("body " + data);
        server.close();
    });
});
req.write("aaa");
req.write("bbbb");
req.write("c");
req.end();
