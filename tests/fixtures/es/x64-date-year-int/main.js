var d = new Date(1978, 3);
if (d.getFullYear() !== 1978) throw new Error("year=" + d.getFullYear());
if (d.getMonth() !== 3) throw new Error("month=" + d.getMonth());
console.log("ok");
