import net from "node:net";

console.log(net.isIP("127.0.0.1"));
console.log(net.isIP("::1"));
console.log(net.isIP("fe80::1"));
console.log(net.isIP("1:2:3:4:5:6:7:8"));
console.log(net.isIP("::ffff:192.0.2.1"));
console.log(net.isIP("1:2:3:4:5:6:192.0.2.1"));
console.log(net.isIP("1.2.3"));
console.log(net.isIP("1::2::3"));
console.log(net.isIP("gggg::1"));
console.log(net.isIP("1:2:3:4:5:6:7"));
console.log(net.isIP("1:2:3:4:5:6:7:8:9"));
console.log(net.isIP("not-an-ip"));
console.log(net.isIPv4("10.0.0.1"));
console.log(net.isIPv4("256.0.0.1"));
console.log(net.isIPv6("::1"));
console.log(net.isIPv6("1:2:3:4:5:192.0.2.1"));
