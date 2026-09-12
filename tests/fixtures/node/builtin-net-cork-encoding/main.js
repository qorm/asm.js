import net from "node:net";

const st = { chunks: [] };

const server = net.createServer();
server.on("connection", (sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => { st.chunks.push(chunk); });
    sock.on("end", () => {
        let all = "";
        for (let i = 0; i < st.chunks.length; i++) all += st.chunks[i];
        console.log(all);
        console.log(all === "pingpong");
        server.close();
    });
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const client = net.connect(port, "127.0.0.1");
client.on("connect", () => {
    console.log(client.writableCorked);
    client.cork();
    client.cork();
    console.log(client.writableCorked);
    client.write("70696e67", "hex");
    client.write("pong");
    client.uncork();
    console.log(client.writableCorked);
    client.uncork();
    console.log(client.writableCorked);
    client.destroySoon();
});
client.on("error", () => {});
