class W {
  end() { return "E"; }
  return() { return "R"; }
  proto() { return "P"; }
  write() { return "W"; }
}
const w = new W();
console.log(w.write());
console.log(w.end());
console.log(w.return());
console.log(w.proto());
