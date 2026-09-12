import net from "node:net";

const st = { received: 0, callbacks: 0, writeFalse: 0, drain: 0, sent: 0, ended: false };
const chunk = "x".repeat(16384);

const server = net.createServer();
server.on("connection", (sock) => {
    sock.pause();
    sock.on("data", (buf) => { st.received += buf.length; });
    sock.on("end", () => {
        console.log("bytes " + st.received);
        console.log("sent " + st.sent);
        console.log("callbacks " + st.callbacks);
        console.log("match " + (st.received === st.sent));
        server.close();
    });
    setImmediate(() => sock.resume());
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const client = net.connect(port, "127.0.0.1");
client.on("data", () => {});
client.on("end", () => {});
client.on("drain", () => { st.drain++; });
client.on("connect", () => {
    for (let i = 0; i < 8; i++) {
        const ok = client.write(chunk, () => { st.callbacks++; });
        st.sent += chunk.length;
        if (!ok) st.writeFalse++;
    }
    if (st.writeFalse === 0) client.end();
    else {
        client.on("drain", () => {
            if (!st.ended) {
                st.ended = true;
                client.end();
            }
        });
    }
});

