import test from "node:test";
import assert from "node:assert/strict";
import { installDependency, manualAlternative } from "../dependencies.mjs";

const spec = {
  id: "ffmpeg",
  name: "FFmpeg",
  bin: "ffmpeg",
  winget: "Gyan.FFmpeg",
  choco: "ffmpeg",
  url: "https://ffmpeg.org/download.html",
};

test("an already installed tool is reported as existing without running an installer", async () => {
  let ran = false;
  const result = await installDependency(spec, {
    run: async () => {
      ran = true;
      return { ok: true, out: "", err: "" };
    },
    binOnPath: () => "C:\\tools\\ffmpeg.exe",
    refreshProcessPath: async () => {},
    toolsDir: "C:\\tools",
    isWin: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, "existing");
  assert.equal(ran, false);
});

test("a package manager install is detected after PATH refreshes", async () => {
  let installed = false;
  const result = await installDependency(spec, {
    run: async (file) => {
      assert.equal(file, "choco");
      installed = true;
      return { ok: true, out: "installed", err: "" };
    },
    binOnPath: (name) => {
      if (name === "choco") return "C:\\ProgramData\\chocolatey\\bin\\choco.exe";
      if (name === "ffmpeg") return installed ? "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe" : null;
      return null;
    },
    refreshProcessPath: async () => {},
    toolsDir: "C:\\tools",
    isWin: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, "choco");
  assert.match(result.where, /ffmpeg\.exe$/);
  assert.equal(result.tried.length, 1);
});

test("failure keeps every attempted method and gives official manual guidance", async () => {
  const result = await installDependency(spec, {
    run: async () => ({ ok: false, out: "", err: "manager refused" }),
    binOnPath: (name) => (name === "winget" || name === "choco" ? `C:\\bin\\${name}.exe` : null),
    refreshProcessPath: async () => {},
    toolsDir: "C:\\tools",
    isWin: false,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0].url, "https://ffmpeg.org/download.html");
  assert.ok(result.tried.some((item) => item.method === "winget"));
  assert.ok(result.tried.some((item) => item.method === "choco"));
  assert.ok(result.tried.some((item) => item.method === "portable"));
  assert.match(result.error, /Could not install FFmpeg/);
});

test("ComfyUI uses folder-specific guidance, not a fake package install", () => {
  const manual = manualAlternative({ id: "comfyui", name: "ComfyUI" });
  assert.equal(manual.method, "manual");
  assert.match(manual.instructions, /folder/i);
  assert.equal(manual.url, "https://www.comfy.org/download");
});
