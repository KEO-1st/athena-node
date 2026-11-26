import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAudioNames,
  cpuUtilization,
  memoryInfo,
  parseAudio,
  parseDisks,
  parseDisplays,
  parseInstalledApps,
  parseInstalledMemory,
  resetInventoryCache,
} from "../inventory.mjs";

test("disk parser keeps measured sizes and unknown values as null", () => {
  const rows = parseDisks(
    JSON.stringify([
      { DeviceID: "C:", VolumeName: "System", Size: 512000000000, FreeSpace: 128000000000 },
      { DeviceID: "D:", VolumeName: null, Size: null, FreeSpace: null },
    ])
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "C:");
  assert.equal(rows[0].totalGb, 476.8);
  assert.equal(rows[0].freeGb, 119.2);
  assert.equal(rows[0].usedPct, 75);
  assert.equal(rows[1].totalGb, null);
  assert.equal(rows[1].freeGb, null);
  assert.equal(rows[1].usedPct, null);
});

test("disk parser rejects empty or malformed output instead of inventing disks", () => {
  assert.equal(parseDisks(""), null);
  assert.equal(parseDisks("not json"), null);
  assert.deepEqual(parseDisks("[]"), []);
});

test("display parser reads resolution, primary flag and refresh rate", () => {
  const rows = parseDisplays(
    JSON.stringify([
      { name: "\\\\.\\DISPLAY1", primary: true, width: 2560, height: 1440, refreshHz: 165 },
      { name: "\\\\.\\DISPLAY2", primary: false, bounds: { width: 1920, height: 1080 } },
    ])
  );
  assert.equal(rows[0].width, 2560);
  assert.equal(rows[0].refreshHz, 165);
  assert.equal(rows[0].primary, true);
  assert.equal(rows[1].width, 1920);
  assert.equal(rows[1].refreshHz, null);
});

test("audio classification separates capture from playback, with no fabricated mic", () => {
  const result = classifyAudioNames([
    "Microphone (USB Audio)",
    "Speakers (Realtek(R) Audio)",
    "Headset Earphone (Bluetooth)",
    "Line In (Realtek)",
    "Microphone (USB Audio)",
  ]);
  assert.deepEqual(result.inputs, ["Microphone (USB Audio)", "Line In (Realtek)"]);
  assert.deepEqual(result.outputs, ["Speakers (Realtek(R) Audio)", "Headset Earphone (Bluetooth)"]);
  assert.equal(result.all.length, 4);
});

test("audio parser returns an empty inventory rather than null for no endpoints", () => {
  assert.deepEqual(parseAudio("[]"), { all: [], inputs: [], outputs: [] });
  assert.equal(parseAudio("garbage"), null);
});

test("installed-app parser de-duplicates names and reports a real count", () => {
  const result = parseInstalledApps(
    JSON.stringify([{ name: "Google Chrome" }, { name: "7-Zip" }, { name: "Google Chrome" }])
  );
  assert.equal(result.count, 2);
  assert.deepEqual(result.sample, ["7-Zip", "Google Chrome"]);
});

test("installed memory is measured separately from usable memory", () => {
  const installed = parseInstalledMemory(
    JSON.stringify([{ Capacity: 17179869184 }, { Capacity: 17179869184 }])
  );
  assert.equal(installed, 32);
  assert.equal(parseInstalledMemory("[]"), null);
  assert.equal(parseInstalledMemory("not json"), null);
});

test("memory and CPU expose null on the first sample instead of a fake zero", () => {
  const memory = memoryInfo();
  assert.ok(memory.totalGb > 0);
  assert.ok(memory.freeGb >= 0);
  assert.equal(memory.installedGb, null, "physical module capacity is filled by memoryInventory, not guessed");
  resetInventoryCache();
  assert.equal(cpuUtilization(), null);
});
