import net from "node:net";

const st = { lookup: "", ready: false };

const server = net.createServer();
server.on("connection", (sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
        console.log(chunk);
        sock.end();
    });
    sock.on("end", () => server.close());
});
server.listen({ port: 0, host: "127.0.0.1" });
const port = server.address().port;

function lookup(host, options, cb) {
    st.lookup = host + ":" + options.family;
    cb(null, "127.0.0.1", 4);
}

const client = net.connect({
    port: port,
    host: "localhost",
    lookup: lookup,
    noDelay: true,
    keepAlive: false
});
client.setEncoding("utf8");
client.on("lookup", (err, address, family, host) => {
    console.log("lookup " + (!err) + " " + address + " " + family + " " + host);
});
client.on("ready", () => { st.ready = true; });
client.on("connect", () => {
    console.log("ready " + st.ready);
    console.log("lookup-arg " + st.lookup);
    client.write("opts");
    client.end();
});
