import net from "node:net";

const path = "/tmp/asmjs-net-unix-" + Date.now() + ".sock";
const st = { lines: [] };

const server = net.createServer();
server.on("connection", (sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
        st.lines.push("recv " + chunk);
        sock.write("ack:" + chunk);
    });
    sock.on("end", () => {
        st.lines.push("end");
        server.close();
    });
});
server.listen(path);
console.log(typeof server.address() === "string");
console.log(server.address() === path);

const client = net.connect({ path: path });
client.setEncoding("utf8");
client.on("connect", () => {
    console.log(client.remoteFamily);
    client.write("unix");
    client.end();
});
client.on("data", (chunk) => { st.lines.push("client " + chunk); });
client.on("end", () => {
    const order = ["recv unix", "end", "client ack:unix"];
    for (let i = 0; i < order.length; i++) {
        if (st.lines.indexOf(order[i]) !== -1) console.log(order[i]);
    }
});
