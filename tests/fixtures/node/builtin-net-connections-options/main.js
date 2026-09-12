import net from "node:net";

const st = { n: 0, counts: [], states: [] };

const server = net.createServer();
server.maxConnections = 1;
server.on("connection", (sock) => {
    st.n++;
    st.states.push(sock.readyState);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 1000);
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
        if (chunk === "one") {
            server.getConnections((err, count) => {
                st.counts.push(count);
                sock.end("ack1");
            });
        } else {
            server.getConnections((err, count) => {
                st.counts.push(count);
                sock.end("ack2");
            });
        }
    });
});
server.listen(0, "127.0.0.1");
const port = server.address().port;
console.log(server.address().port > 0);
console.log(server.address().family);

const c1 = net.connect(port, "127.0.0.1");
c1.setEncoding("utf8");
c1.on("connect", () => c1.write("one"));
c1.on("data", (chunk) => {
    console.log(chunk);
    c1.end();
});
c1.on("close", () => {
    const c2 = net.connect(port, "127.0.0.1");
    c2.setEncoding("utf8");
    c2.on("connect", () => c2.write("two"));
    c2.on("data", (chunk) => {
        console.log(chunk);
        c2.end();
    });
    c2.on("close", () => {
        setImmediate(() => {
            server.getConnections((err, count) => {
                console.log("n " + st.n);
                console.log("counts " + st.counts.join(","));
                console.log("final " + count);
                console.log("open " + (st.states[0] === "open" && st.states[1] === "open"));
                server.close();
            });
        });
    });
});
