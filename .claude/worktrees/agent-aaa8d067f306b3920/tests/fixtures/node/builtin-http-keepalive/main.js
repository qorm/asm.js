// HTTP/1.1 keep-alive connection pooling: a keepAlive Agent reuses one TCP
// connection across sequential requests to the same host:port (verified by fd
// identity + the Agent's reused/created counters), and the process still exits
// cleanly (idle pooled sockets are unwatched so they never stall the loop).
// Also exercises multiple concurrent independent connections and a larger body.
import http from "node:http";

let served = 0;
const server = http.createServer((req, res) => {
    served++;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/plain", "X-Count": String(served) });
        res.end("n=" + served + " path=" + req.url + " blen=" + body.length);
    });
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const fds = [];

function seq(n, body, after) {
    const req = http.request(
        { host: "127.0.0.1", port: port, method: "POST", path: "/s" + n, agent: agent },
        (res) => {
            let data = "";
            res.on("data", (c) => { data += c; });
            res.on("end", () => {
                fds.push(req.socket.fd);
                console.log("seq" + n + ": status=" + res.statusCode + " " + data);
                after();
            });
        }
    );
    req.end(body);
}

// Three sequential keep-alive requests over one pooled socket, then a batch of
// concurrent default (Connection: close) requests on their own connections.
seq(1, "hello", () =>
    seq(2, "x".repeat(3000), () =>
        seq(3, "bye", () => {
            console.log("reused=" + agent.reused + " created=" + agent.created);
            console.log("pooledOneSocket=" + (fds[0] === fds[1] && fds[1] === fds[2]));

            let done = 0;
            const N = 3;
            const out = [];
            for (let i = 1; i <= N; i++) {
                const r = http.request(
                    { host: "127.0.0.1", port: port, method: "GET", path: "/c" + i },
                    (res) => {
                        let d = "";
                        res.on("data", (c) => { d += c; });
                        res.on("end", () => {
                            out.push("concurrent status=" + res.statusCode);
                            if (++done === N) {
                                out.sort();
                                for (let k = 0; k < out.length; k++) console.log(out[k]);
                                agent.destroy();
                                server.close();
                            }
                        });
                    }
                );
                r.end();
            }
        })
    )
);
