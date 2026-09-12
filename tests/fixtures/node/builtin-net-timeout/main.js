import net from "node:net";

const st = { got: 0 };

const server = net.createServer();
server.on("connection", (sock) => {
    sock.setTimeout(50, () => {
        st.got++;
        console.log("timeout");
        console.log(sock.destroyed ? "destroyed" : "open");
        sock.destroy();
        server.close();
    });
});
server.listen(0, "127.0.0.1");
const client = net.connect(server.address().port, "127.0.0.1");
client.on("error", () => {});
