// [dialect] Channel(capacity) + js-spawn: rendezvous, buffering, close semantics.
// recv() resolves {value, done}: done:true = closed and drained.
const ch = Channel(0);
async function producer(c) {
  for (let i = 1; i <= 3; i++) { console.log("send " + i); await c.send(i); }
  c.close();
}
async function consumer(c) {
  while (true) {
    const r = await c.recv();
    if (r.done) break;
    console.log("recv " + r.value);
  }
  console.log("consumer-done");
}
js producer(ch);
js consumer(ch);
console.log("main-end");

// buffered: two sends complete without a receiver; third suspends until drained
const b = Channel(2);
async function bp(c) {
  await c.send("a"); console.log("sent-a");
  await c.send("b"); console.log("sent-b");
  await c.send("c"); console.log("sent-c");
  c.close();
}
async function br(c) {
  let x;
  while (!(x = await c.recv()).done) console.log("got " + x.value);
}
js bp(b);
js br(b);

// close wakes all waiting receivers with done:true (FIFO)
const w = Channel(0);
async function waiter(c, tag) { const r = await c.recv(); console.log(tag + " " + r.done + " " + String(r.value)); }
async function closer(c) { c.close(); }
js waiter(w, "w1");
js waiter(w, "w2");
js closer(w);
