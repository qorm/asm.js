"use strict";
function run() {
  print((3.5).toString());
  print("ab".toString());
  print({}.toString());
  print([1, 2].toString());
  print((10).toFixed(0));
  print((7).valueOf());
  print({ x: 1 }.valueOf().x);
  var d = new Date(Date.UTC(2020, 0, 2));
  print(d.valueOf() > 0);
  print(d.toString().indexOf("2020") >= 0);
}
run();
