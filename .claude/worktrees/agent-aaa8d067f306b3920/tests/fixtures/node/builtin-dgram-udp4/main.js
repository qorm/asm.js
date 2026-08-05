// Minimal real UDP/IPv4 over dgram: an in-process loopback datagram send/receive
// driven by the shared net poll(2) readiness pump. A receiver binds an ephemeral
// port; a sender sends one datagram to it; the receiver's 'message' event yields
// the payload Buffer and the sender's rinfo (address/family/size — the ephemeral
// sender port is nondeterministic so it is not printed).
import dgram from "node:dgram";

const server = dgram.createSocket("udp4");
server.on("message", (msg, rinfo) => {
    console.log("recv " + msg.toString());
    console.log("from " + rinfo.address + " " + rinfo.family + " size=" + rinfo.size);
    server.close();
});
server.bind(0, "127.0.0.1");
const port = server.address().port;

const client = dgram.createSocket("udp4");
client.send("hello-udp", port, "127.0.0.1", (err) => {
    console.log("sent " + (err ? "err" : "ok"));
    client.close();
});
