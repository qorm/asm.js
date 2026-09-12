import net from "node:net";

const a = new net.SocketAddress({ address: "127.0.0.1", port: 80 });
console.log(a.address);
console.log(a.port);
console.log(a.family);
console.log(net.SocketAddress.isSocketAddress(a));
console.log(net.SocketAddress.isSocketAddress({ address: "127.0.0.1" }));

const p = net.SocketAddress.parse("10.0.0.1:443");
console.log(p.address);
console.log(p.port);
console.log(p.family);

const v6 = net.SocketAddress.parse("[::1]:22");
console.log(v6.address);
console.log(v6.port);
console.log(v6.family);

console.log(net.SocketAddress.parse("not-an-address") === undefined);
console.log(net.SocketAddress.parse("1.2.3.4") === undefined);
console.log(net.SocketAddress.parse("1.2.3.4:99999") === undefined);

const mapped = new net.SocketAddress({ address: "::ffff:127.0.0.1", port: 9, family: "ipv6" });
console.log(mapped.family);

const server = net.createServer();
server.on("connection", (sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
        console.log(chunk);
        sock.end();
    });
    sock.on("end", () => server.close());
});
server.listen(0, "127.0.0.1");
const sa = new net.SocketAddress({ address: "127.0.0.1", port: server.address().port });
const client = net.connect(sa);
client.setEncoding("utf8");
client.on("connect", () => {
    client.write("via-sa");
    client.end();
});
