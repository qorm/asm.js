import { URL, URLSearchParams } from "node:url";

const u = new URL("https://user:pw@example.com:8080/path?x=1&y=2#frag");
console.log(u.protocol);
console.log(u.hostname);
console.log(u.host);
console.log(u.port);
console.log(u.pathname);
console.log(u.origin);
console.log(u.searchParams.get("x") + "," + u.searchParams.get("y"));

const sp = new URLSearchParams("a=1&b=2&a=3");
console.log(sp.getAll("a").join(","));
console.log(sp.has("b") + "," + sp.has("z"));
sp.set("a", "X");
sp.append("c", "9");
console.log(sp.toString());
