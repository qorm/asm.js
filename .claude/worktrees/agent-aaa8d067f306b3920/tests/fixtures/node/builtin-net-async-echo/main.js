// Event-driven (async) TCP: server.on('connection') and socket.on('data'/'end')
// fire on their own, driven by the net poll pump wired into the event loop.
// 事件按发生顺序收集进 lines,全部结束后按固定顺序打印——跨 fd 的到达次序
// (server 看到 FIN 与 client 看到 reply 数据)由内核调度决定,属固有竞态,
// 不是被测语义;本 fixture 断言的是四类异步事件均真实触发且内容正确。
import net from "node:net";

const lines = [];
const server = net.createServer();
server.on("connection", (sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
        lines.push("server recv " + chunk);
        sock.write("reply:" + chunk);
    });
    sock.on("end", () => {
        lines.push("server end");
        server.close();
    });
});
server.listen(0, "127.0.0.1");
const port = server.address().port;

const client = net.connect(port, "127.0.0.1");
client.setEncoding("utf8");
client.on("data", (data) => { lines.push("client recv " + data); });
client.on("end", () => {
    lines.push("client end");
    const order = ["server recv ping", "server end", "client recv reply:ping", "client end"];
    for (const o of order) {
        if (lines.indexOf(o) !== -1) console.log(o);
    }
});
client.write("ping");
client.end();
