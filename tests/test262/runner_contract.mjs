#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  RELEASE_TARGETS,
  describeRunner,
  hostPlatform,
} from "./exec-target.mjs";

assert.deepEqual(
  RELEASE_TARGETS,
  ["macos-arm64", "macos-x64", "linux-arm64", "linux-x64", "windows-x64"],
);

const unknown = describeRunner("not-a-target");
assert.equal(unknown.runnable, false);
assert.equal(unknown.mode, "unknown");

const host = hostPlatform();
if (host.os === "macos" || host.os === "linux") {
  const self = describeRunner(host.name);
  assert.equal(self.runnable, true, "host target must be runnable: " + self.reason);
  assert.equal(self.mode, "direct");
  assert.equal(self.resolved, host.name);
}

if (host.name === "macos-arm64") {
  const x64 = describeRunner("macos-x64");
  assert.equal(x64.runnable, true, "macos-x64 via Rosetta: " + x64.reason);
  assert.equal(x64.mode, "rosetta");
  const alias = describeRunner("darwin-amd64");
  assert.equal(alias.resolved, "macos-x64");
  assert.equal(alias.runnable, true);
}

console.log("test262 runner contract: PASS (host " + host.name + ")");
