function build(args) {
  return String.fromCodePoint.apply(null, args.loneCodePoints);
}
print(build({
  loneCodePoints: [0x0000AA, 0x0000BA, 0x002071, 0x00207F, 0x002132, 0x00214E]
}));
