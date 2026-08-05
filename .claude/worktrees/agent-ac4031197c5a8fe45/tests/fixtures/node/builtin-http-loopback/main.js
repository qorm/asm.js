// Minimal real HTTP/1.1 over the async net layer: an in-process loopback
// request/response with request line, headers, and body in both directions.
import http from "node:http";

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/plain", "X-Method": req.method });
        res.end("hello " + req.url + " [" + body + "]");
    });
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const req = http.request({ host: "127.0.0.1", port: port, method: "POST", path: "/echo" }, (res) => {
    console.log("status " + res.statusCode);
    console.log("content-type " + res.headers["content-type"]);
    console.log("x-method " + res.headers["x-method"]);
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
        console.log("body " + data);
        server.close();
    });
});
req.write("payload");
req.end();
