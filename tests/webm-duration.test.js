const assert = require("node:assert/strict");
require("../src/shared/webm-duration.js");

const { _repairBytesForTest, repairWebmDuration } = globalThis.TabVaultWebm;

function concat(...parts) {
  const arrays = parts.map((part) => Uint8Array.from(part));
  const size = arrays.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of arrays) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function float64Bytes(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

function fixture(durationValue = null) {
  const ebmlHeader = [0x1a, 0x45, 0xdf, 0xa3, 0x80];
  const segmentHeader = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const timecodeScale = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
  const duration = durationValue == null
    ? []
    : concat([0x44, 0x89, 0x88], float64Bytes(durationValue));
  const infoData = concat(timecodeScale, duration);
  const info = concat(
    [0x15, 0x49, 0xa9, 0x66, 0x80 | infoData.length],
    infoData
  );
  const emptyCluster = [0x1f, 0x43, 0xb6, 0x75, 0x80];
  return concat(ebmlHeader, segmentHeader, info, emptyCluster);
}

function findDuration(bytes) {
  const matches = [];
  for (let i = 0; i <= bytes.length - 11; i += 1) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88) {
      matches.push({
        offset: i,
        value: new DataView(bytes.buffer, bytes.byteOffset + i + 3, 8).getFloat64(0, false)
      });
    }
  }
  return matches;
}

{
  const input = fixture();
  const output = _repairBytesForTest(input, 65_432);
  const durations = findDuration(output);
  assert.equal(durations.length, 1);
  assert.ok(Math.abs(durations[0].value - 65_432) < 0.001);
  assert.ok(output.length > input.length);
}

{
  const input = fixture(30_000);
  const output = _repairBytesForTest(input, 120_000);
  const durations = findDuration(output);
  assert.equal(durations.length, 1);
  assert.ok(Math.abs(durations[0].value - 120_000) < 0.001);
}

(async () => {
  const nonWebm = new Blob(["not webm"], { type: "text/plain" });
  const output = await repairWebmDuration(nonWebm, 60_000);
  assert.equal(output, nonWebm);
  console.log("WebM duration repair tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
