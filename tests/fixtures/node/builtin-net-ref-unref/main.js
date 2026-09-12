import net from "node:net";

const server = net.createServer();
server.listen(0, "127.0.0.1");
console.log(server.hasRef());
server.unref();
console.log(server.hasRef());
console.log("unref-ok");
