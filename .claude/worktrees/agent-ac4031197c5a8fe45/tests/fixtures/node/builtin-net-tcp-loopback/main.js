import net from "node:net";

// address-family classification
console.log(net.isIP("127.0.0.1"));   // 4
console.log(net.isIP("::1"));         // 6
console.log(net.isIP("not-an-ip"));   // 0
console.log(net.isIPv4("10.0.0.1"));  // true
console.log(net.isIPv6("fe80::1"));   // true

// Real TCP over loopback in one process: bind+listen, connect (the kernel
// completes the handshake and queues the connection), write, then accept+read.
// No threads/fork and no poll/kqueue needed for this synchronous pattern.
const server = net.createServer();
server.listen(0, "127.0.0.1");
const port = server.address().port;
console.log(port > 0);                // ephemeral port assigned via getsockname

const client = net.connect(port, "127.0.0.1");
client.write("ping from client");

const conn = server.accept();
conn.setEncoding("utf8");
console.log(conn.read());             // ping from client

conn.write("pong from server");
client.setEncoding("utf8");
console.log(client.read());           // pong from server

conn.destroy();
client.destroy();
server.close();
console.log(server.listening);        // false
