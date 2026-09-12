import net from "node:net";

const st = { lines: [], done: 0 };

function finish() {
    st.done++;
    if (st.done < 2) return;
    const order = ["open", "pending-false", "local-ok", "127.0.0.1", "hello"];
    for (let i = 0; i < order.length; i++) {
        if (st.lines.indexOf(order[i]) !== -1) console.log(order[i]);
    }
}

const server = net.createServer();
server.on("connection", (sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
        st.lines.push(chunk);
        sock.end();
    });
    sock.on("end", () => {
        server.close();
        finish();
    });
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const client = net.connect(port, "127.0.0.1");
client.setEncoding("utf8");
client.write("hello");
client.on("connect", () => {
    st.lines.push(client.readyState);
    st.lines.push(client.pending ? "pending-true" : "pending-false");
    st.lines.push(client.localPort > 0 ? "local-ok" : "local-bad");
    st.lines.push(client.remoteAddress);
    client.unref();
});
client.on("end", () => finish());
