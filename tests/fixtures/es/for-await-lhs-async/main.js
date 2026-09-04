let async;
async function fn() {
  for await (async of [7]);
}
fn().then(function () { console.log(async); }).catch(function (e) { console.log(e && e.name); });
