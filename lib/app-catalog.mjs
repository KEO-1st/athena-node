/**
 * The one app catalogue.
 *
 * The hub's per-node SOFTWARE section and the node's installer both read this
 * file, so an app can never appear on one side and be unknown on the other.
 * Display fields are used by the hub; `winget` and `bin` are used on the
 * machine that installs it.
 */
export const APP_CATALOG = [
  {
    id: "comfyui",
    name: "ComfyUI",
    tag: "IMAGE · VIDEO",
    service: true,
    blurb:
      "Node-based image and video generation. Detect an existing install, start it, stop it, and open its canvas.",
    detail: "Set the folder once in the node panel (or let FIND COMFY detect it). Needs a CUDA GPU for real speed.",
    install: "detect",
    size: "~2 GB + models",
    winget: "",
    choco: "",
    bin: "",
    url: "https://www.comfy.org/download",
  },
  {
    id: "ollama",
    name: "Ollama",
    tag: "AI BRAIN",
    service: true,
    blurb:
      "Runs free open models locally on that machine. Give a node with a big GPU its own brain, or use it as the hub's brain.",
    detail: "Installed from ollama.com through winget. Models are pulled on demand.",
    install: "winget",
    size: "~1 GB + models",
    winget: "Ollama.Ollama",
    choco: "ollama",
    bin: "ollama",
    url: "https://ollama.com/download",
  },
  {
    id: "ffmpeg",
    name: "FFmpeg",
    tag: "AUDIO · VIDEO",
    service: false,
    blurb:
      "The engine behind hearing a machine's sound (system audio relay), plus every conversion, cut and encode you would ask for.",
    detail: "Also needed for the LISTEN button on the SCREEN page. Install, then restart the node agent.",
    install: "winget",
    size: "~150 MB",
    winget: "Gyan.FFmpeg",
    choco: "ffmpeg",
    bin: "ffmpeg",
    url: "https://www.gyan.dev/ffmpeg/builds/",
  },
  {
    id: "python",
    name: "Python",
    tag: "RUNTIME",
    service: false,
    blurb: "Runs scripts, training jobs and anything the brain writes for a machine.",
    detail: "ComfyUI portable brings its own embedded Python; this one is for everything else.",
    install: "winget",
    size: "~100 MB",
    winget: "Python.Python.3.12",
    choco: "python",
    bin: "python",
    url: "https://www.python.org/downloads/windows/",
  },
  {
    id: "git",
    name: "Git",
    tag: "SOURCE",
    service: false,
    blurb: "Clone custom nodes, tools and repos straight onto a node.",
    detail: "",
    install: "winget",
    size: "~60 MB",
    winget: "Git.Git",
    choco: "git",
    bin: "git",
    url: "https://git-scm.com/download/win",
  },
  {
    id: "ytdlp",
    name: "yt-dlp",
    tag: "REFERENCE",
    service: false,
    blurb: "Pull reference clips, music and tutorials onto the machine that will render.",
    detail: "Download only what you have the right to use.",
    install: "winget",
    size: "~20 MB",
    winget: "yt-dlp.yt-dlp",
    choco: "yt-dlp",
    bin: "yt-dlp",
    url: "https://github.com/yt-dlp/yt-dlp/releases",
  },
  {
    id: "7zip",
    name: "7-Zip",
    tag: "UTILITY",
    service: false,
    blurb: "Unpack model archives and portable builds without leaving ATHENA.",
    detail: "",
    install: "winget",
    size: "~5 MB",
    winget: "7zip.7zip",
    choco: "7zip",
    bin: "7z",
    url: "https://www.7-zip.org/download.html",
  },
];

/** The hub-facing catalogue (no install commands leave the hub). */
export const APPS = APP_CATALOG.map(({ winget, choco, bin, ...rest }) => rest);

/** The node-facing install specs. */
export const APP_SPECS = APP_CATALOG.map(({ id, name, winget, choco, bin, service, install, url }) => ({ id, name, winget, choco, bin, service, install, url }));

export function appById(id) {
  return APP_CATALOG.find((app) => app.id === String(id || "").toLowerCase()) || null;
}
