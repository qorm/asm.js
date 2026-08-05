console.log(isNaN(Date.parse("not a date")));
console.log(isNaN(Date.parse("garbage")));
console.log(isNaN(new Date("bad").getTime()));
console.log(Date.parse("2021-06-15"));
console.log(Date.parse("2021-06-15T12:30:45Z"));
