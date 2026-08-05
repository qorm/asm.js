console.log(/abc/gi.toString());
let r = /x/g;
console.log(r.toString());
console.log(String(/hello/));
console.log(new RegExp("\\d+", "m").toString());
console.log(/x/u.unicode, /x/.unicode, /x/gi.unicode);
console.log(/x/gimsuy.flags, /x/gimsuy.unicode);
console.log("id=" + String(/test/i));
