function tag(s) {
  console.log(s[0] === undefined ? "undef" : s[0]);
  console.log(s.raw[0]);
}
tag`\01`;
tag`\9`;
tag`\xg`;
function tag2(s, v) {
  console.log(s[0] === undefined ? "undef" : s[0]);
  console.log(v);
  console.log(s[1]);
}
tag2`\u{10FFFFF}${"inner"}right`;
