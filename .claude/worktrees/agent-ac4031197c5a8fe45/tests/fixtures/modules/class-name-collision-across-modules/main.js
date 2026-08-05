import { makeNet } from "./net.js";
import { makeHttp } from "./http.js";
console.log(makeNet().who());
console.log(makeHttp().who());
