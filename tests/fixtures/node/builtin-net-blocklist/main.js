import net from "node:net";

const bl = new net.BlockList();
bl.addAddress("10.0.0.1");
bl.addRange("10.0.0.10", "10.0.0.20");
bl.addSubnet("192.168.1.0", 24);

console.log(bl.check("10.0.0.1"));
console.log(bl.check("10.0.0.2"));
console.log(bl.check("10.0.0.10"));
console.log(bl.check("10.0.0.20"));
console.log(bl.check("10.0.0.21"));
console.log(bl.check("192.168.1.50"));
console.log(bl.check("192.168.2.1"));

const sa = new net.SocketAddress({ address: "10.0.0.1", port: 1 });
console.log(bl.check(sa));

const v6 = new net.BlockList();
v6.addAddress("::1", "ipv6");
console.log(v6.check("::1", "ipv6"));
console.log(v6.check("::2", "ipv6"));
console.log(v6.check("10.0.0.1"));
