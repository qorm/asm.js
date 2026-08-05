const data = JSON.parse('{"a":1,"b":[true,null,"x"],"c":{"d":2}}');

console.log(data.a);
console.log(data.b[0]);
console.log(data.b[1]);
console.log(data.b[2]);
console.log(data.c.d);
