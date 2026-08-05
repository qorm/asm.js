import { URL } from "node:url";
console.log(new URL("https://x.io").pathname);
console.log(new URL("http://a.com/p").pathname);
console.log(new URL("https://h.com").origin);
