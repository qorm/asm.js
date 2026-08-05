function direct() {
  return "direct-ok";
}

function callDirect() {
  direct();
  return "call-ok";
}

const api = {
  direct,
  callDirect
};

export { api, direct, callDirect };

console.log(api.direct());
console.log(api.callDirect());
