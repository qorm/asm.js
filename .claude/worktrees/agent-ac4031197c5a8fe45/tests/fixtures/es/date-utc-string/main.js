let d = new Date(Date.UTC(2021, 5, 15, 12, 30, 45));
console.log(d.toUTCString());
console.log(d.toGMTString());
console.log(new Date(Date.UTC(2021, 5, 5, 3, 7, 9)).toUTCString());
console.log(new Date(Date.UTC(1999, 11, 31, 23, 59, 59)).toUTCString());
console.log(new Date(2021, 5, 15).toDateString());
console.log(new Date(2021, 5, 5).toDateString());
for (let i = 0; i < 7; i++) console.log(new Date(Date.UTC(2021, 5, 14 + i)).toUTCString());
