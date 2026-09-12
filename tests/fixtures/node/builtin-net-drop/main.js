import net from "node:net";

const st = { n: 0, drops: 0 };

const server = net.createServer();
server.maxConnections = 1;
server.on("connection", (sock) => {
    st.n++;
    sock.on("data", () => {});
    sock.on("end", () => {});
});
server.on("drop", (data) => {
    st.drops++;
    console.log(data.remoteFamily);
    console.log(data.localPort > 0);
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const c1 = net.connect(port, "127.0.0.1");
c1.on("connect", () => {
    const c2 = net.connect(port, "127.0.0.1");
    c2.on("error", () => {});
    c2.on("close", () => {
        setImmediate(() => {
            console.log("n " + st.n);
            console.log("drops " + st.drops);
            c1.end();
            server.close();
        });
    });
});
c1.on("error", () => {});
