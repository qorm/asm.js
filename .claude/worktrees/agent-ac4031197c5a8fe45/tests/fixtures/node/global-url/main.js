const u = new URL("https://user:pass@host.com:8080/a/b?x=1&y=2#frag");
console.log(u.protocol, u.hostname, u.port);
console.log(u.pathname, u.search, u.hash);
console.log(u.searchParams.get("x"), u.searchParams.get("y"));
const sp = new URLSearchParams("a=1&b=two");
console.log(sp.get("a"), sp.get("b"), sp.toString());
