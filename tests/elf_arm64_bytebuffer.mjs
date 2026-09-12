#!/usr/bin/env node
// linux-arm64 ELF must copy ByteBuffer code/data by value, not `buf[i]`
// (undefined → zero-filled PT_LOAD → SIGILL at e_entry).
import assert from "node:assert/strict";
import { ByteBuffer } from "../asm/byte-buffer.js";
import { ELF64ARM64Generator } from "../binary/elf_arm64.js";

const code = new ByteBuffer();
code.emit32(0x910003e8); // add x8, x0, #0
code.emit32(0xd65f03c0); // ret
const data = new ByteBuffer();
data.push(0x41, 0x42, 0x43, 0x00);

const bytes = Uint8Array.from(new ELF64ARM64Generator().generate(code, data));
const at = 0x1000;
assert.equal(bytes[at], 0xe8);
assert.equal(bytes[at + 1], 0x03);
assert.equal(bytes[at + 2], 0x00);
assert.equal(bytes[at + 3], 0x91);
assert.equal(bytes[at + 4], 0xc0);
assert.equal(bytes[at + 5], 0x03);
assert.equal(bytes[at + 6], 0x5f);
assert.equal(bytes[at + 7], 0xd6);

console.log("elf_arm64_bytebuffer: PASS");
