// Same top-level class name `Server` as http.js below. Before the fix, both
// classes' constructor/method bodies emitted identical local labels
// (Server_endif_2, ...) that silently overwrote each other -> cross-class jumps.
export class Server {
  constructor(cond) { if (cond) { this.a = 1; } this.finish("NET"); }
  finish(x) { this.kind = x; }
  who() { return this.kind; }
}
export function makeNet() { return new Server(false); }
