using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

/*
 * ATHENA Node desktop launcher.
 *
 * The agent is a Node.js process. This launcher gives the product one Windows
 * face: a single tray identity, one panel window, crash recovery and a clean
 * restart/quit path. A second launch never opens a second panel; it signals the
 * running launcher through a named event and exits quietly.
 */
namespace AthenaNode
{
    internal static class Program
    {
        /* Production uses one fixed namespace. Tests (and portable side-by-side
           installs) can set ATHENA_LAUNCHER_NAMESPACE so an unrelated running
           Node does not look like a second instance of the same product. */
        private static readonly string NamespaceSuffix = NamespaceFromEnvironment();
        private static readonly string LauncherMutex = "ATHENA.Node.Launcher" + NamespaceSuffix;
        private static readonly string OpenPanelEvent = "ATHENA.Node.OpenPanel" + NamespaceSuffix;

        private static string NamespaceFromEnvironment()
        {
            string value = Environment.GetEnvironmentVariable("ATHENA_LAUNCHER_NAMESPACE");
            if (String.IsNullOrEmpty(value)) return ".0_3";
            var clean = new StringBuilder();
            foreach (char c in value)
            {
                if (Char.IsLetterOrDigit(c) || c == '.' || c == '_' || c == '-') clean.Append(c);
            }
            return clean.Length == 0 ? ".0_3" : "." + clean.ToString();
        }

        [STAThread]
        private static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, LauncherMutex, out created))
            using (var openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, OpenPanelEvent))
            {
                if (!created)
                {
                    /* Another launcher already owns the tray and panel. Wake it
                       instead of showing a duplicate-instance dialog. */
                    try { openEvent.Set(); } catch { }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new LauncherContext(openEvent));
            }
        }
    }

    internal sealed class LauncherContext : ApplicationContext
    {
        private readonly NotifyIcon tray;
        private readonly Control marshal;
        private readonly System.Windows.Forms.Timer restartTimer;
        private readonly System.Windows.Forms.Timer stableTimer;
        private readonly EventWaitHandle openEvent;
        private readonly string root;
        private readonly string appDir;
        private readonly string runtime;
        private readonly string dataDir;
        private readonly string logFile;
        private Process child;
        private Process panel;
        private bool quitting;
        private bool panelOpening;
        private int crashCount;
        private int crashDelayMs = 1500;
        private const int MaxCrashRestarts = 3;
        private int port = 47910;

        public LauncherContext(EventWaitHandle openEvent)
        {
            this.openEvent = openEvent;
            root = AppDomain.CurrentDomain.BaseDirectory;
            appDir = Path.Combine(root, "app");
            runtime = Path.Combine(root, "runtime", "node.exe");
            dataDir = Environment.GetEnvironmentVariable("ATHENA_NODE_DIR");
            if (String.IsNullOrEmpty(dataDir))
                dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ATHENA Node");
            Directory.CreateDirectory(dataDir);
            logFile = Path.Combine(dataDir, "launcher.log");
            port = ReadPort();

            var menu = new ContextMenu();
            menu.MenuItems.Add("Open ATHENA Node", delegate { OpenPanel(); });
            menu.MenuItems.Add("Restart node", delegate { RestartChild(); });
            menu.MenuItems.Add("Open data folder", delegate { Process.Start("explorer.exe", dataDir); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("Quit", delegate { Quit(); });

            tray = new NotifyIcon();
            tray.Icon = LoadIcon();
            tray.Text = "ATHENA Node";
            tray.ContextMenu = menu;
            tray.Visible = true;
            tray.DoubleClick += delegate { OpenPanel(); };

            marshal = new Control();
            marshal.CreateControl();

            restartTimer = new System.Windows.Forms.Timer();
            restartTimer.Interval = 1200;
            restartTimer.Tick += delegate
            {
                restartTimer.Stop();
                if (!quitting) StartChild();
            };

            stableTimer = new System.Windows.Forms.Timer();
            stableTimer.Interval = 60000;
            stableTimer.Tick += delegate
            {
                stableTimer.Stop();
                crashCount = 0;
                crashDelayMs = 1500;
                WriteLog("node stayed healthy for 60s; crash backoff reset");
            };

            var signal = new Thread(delegate()
            {
                while (!quitting)
                {
                    try
                    {
                        if (!openEvent.WaitOne(1000)) continue;
                        if (quitting) return;
                        try { marshal.BeginInvoke((Action)OpenPanel); } catch { }
                    }
                    catch { return; }
                }
            });
            signal.IsBackground = true;
            signal.Start();

            if (!File.Exists(runtime) || !File.Exists(Path.Combine(appDir, "athena-node.mjs")))
            {
                tray.ShowBalloonTip(6000, "ATHENA Node is incomplete",
                    "runtime\\node.exe or app\\athena-node.mjs is missing. Extract the whole package.", ToolTipIcon.Error);
                return;
            }

            StartChild();
        }

        private static Icon LoadIcon()
        {
            try
            {
                string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app", "assets", "athena.ico");
                if (File.Exists(file)) return new Icon(file);
            }
            catch { }
            try
            {
                Icon associated = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (associated != null) return associated;
            }
            catch { }
            return SystemIcons.Application;
        }

        private int ReadPort()
        {
            try
            {
                string file = Path.Combine(dataDir, "config.json");
                if (!File.Exists(file)) return 47910;
                Match match = Regex.Match(File.ReadAllText(file), "\"port\"\\s*:\\s*(\\d+)");
                if (match.Success)
                {
                    int value;
                    if (Int32.TryParse(match.Groups[1].Value, out value) && value > 1024 && value < 65535) return value;
                }
            }
            catch { }
            return 47910;
        }

        private void StartChild()
        {
            if (quitting || (child != null && !child.HasExited)) return;
            try
            {
                port = ReadPort();
                var info = new ProcessStartInfo();
                info.FileName = runtime;
                info.Arguments = "\"" + Path.Combine(appDir, "athena-node.mjs") + "\"";
                info.WorkingDirectory = appDir;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                info.StandardOutputEncoding = Encoding.UTF8;
                info.StandardErrorEncoding = Encoding.UTF8;
                info.EnvironmentVariables["ATHENA_NODE_DIR"] = dataDir;
                info.EnvironmentVariables["ATHENA_LAUNCHED_BY"] = "desktop";
                info.EnvironmentVariables["ATHENA_LAUNCHER"] = Application.ExecutablePath;

                child = new Process();
                child.StartInfo = info;
                child.EnableRaisingEvents = true;
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog(e.Data); };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog(e.Data); };
                var startedProcess = child;
                child.Exited += delegate(object sender, EventArgs e) { ChildExited(startedProcess); };
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                WriteLog("launcher started node " + child.Id + " (port " + port + ")");
                tray.Text = "ATHENA Node · starting";
                WaitForHealth();
            }
            catch (Exception error)
            {
                WriteLog("launcher start failed: " + error);
                child = null;
                tray.ShowBalloonTip(6000, "ATHENA Node could not start", error.Message, ToolTipIcon.Error);
                RecoverFromFailure("the agent could not start");
            }
        }

        private void WaitForHealth()
        {
            var thread = new Thread(delegate()
            {
                for (int attempt = 0; attempt < 60; attempt++)
                {
                    if (quitting || child == null || child.HasExited) return;
                    if (Healthy())
                    {
                        tray.Text = "ATHENA Node · running";
                        stableTimer.Start();
                        try
                        {
                            if (Environment.GetEnvironmentVariable("ATHENA_NO_BROWSER") != "1")
                                marshal.BeginInvoke((Action)OpenPanel);
                        }
                        catch { }
                        return;
                    }
                    Thread.Sleep(400);
                }
                try
                {
                    tray.ShowBalloonTip(5000, "ATHENA Node is not answering",
                        "The agent did not become healthy. It will be stopped before a bounded retry.", ToolTipIcon.Warning);
                }
                catch { }
                StopChild();
                RecoverFromFailure("the agent never answered /api/hello");
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private bool Healthy()
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/hello");
                request.Timeout = 1200;
                request.ReadWriteTimeout = 1200;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch { return false; }
        }

        private void ChildExited(Process source)
        {
            if (source != child) return;
            /* Process.Exited arrives on a worker thread. Tray and timer calls
               must move back to the WinForms thread. */
            if (marshal.InvokeRequired)
            {
                try { marshal.BeginInvoke((Action)delegate { OnChildExit(source); }); } catch { }
                return;
            }
            OnChildExit(source);
        }

        private void OnChildExit(Process source)
        {
            if (source != child) return;
            int code = -1;
            try { code = source.ExitCode; } catch { }
            WriteLog("node exited with code " + code);
            child = null;
            stableTimer.Stop();
            if (quitting) return;
            if (code == 76) { Quit(); return; }
            if (code == 75)
            {
                tray.Text = "ATHENA Node · restarting";
                restartTimer.Interval = 800;
                restartTimer.Start();
                return;
            }
            RecoverFromFailure("the agent exited with code " + code);
        }

        private void RecoverFromFailure(string reason)
        {
            if (quitting) return;
            crashCount++;
            if (crashCount <= MaxCrashRestarts)
            {
                crashDelayMs = Math.Min(30000, 1500 * (1 << (crashCount - 1)));
                tray.Text = "ATHENA Node · recovering";
                tray.ShowBalloonTip(3500, "ATHENA Node stopped",
                    reason + ". Restarting in " + (crashDelayMs / 1000) + "s (attempt " + crashCount + " of " + MaxCrashRestarts + ").", ToolTipIcon.Warning);
                restartTimer.Interval = crashDelayMs;
                restartTimer.Start();
            }
            else
            {
                tray.Text = "ATHENA Node · stopped";
                tray.ShowBalloonTip(8000, "ATHENA Node stopped",
                    reason + ". It failed " + MaxCrashRestarts + " times and will not retry automatically. Open the data folder and read launcher.log, then use Restart node.", ToolTipIcon.Error);
            }
        }

        private void RestartChild()
        {
            if (quitting) return;
            crashCount = 0;
            crashDelayMs = 1500;
            stableTimer.Stop();
            StopChild();
            tray.Text = "ATHENA Node · restarting";
            restartTimer.Interval = 500;
            restartTimer.Start();
        }

        private void StopChild()
        {
            stableTimer.Stop();
            var process = child;
            child = null;
            if (process == null) return;
            try
            {
                if (!process.HasExited)
                {
                    Process.Start(new ProcessStartInfo("taskkill", "/pid " + process.Id + " /t /f") { UseShellExecute = false, CreateNoWindow = true });
                    process.WaitForExit(5000);
                }
            }
            catch { }
        }

        private void OpenPanel()
        {
            if (quitting) return;
            if (panel != null && !panel.HasExited)
            {
                if (FocusPanel(panel)) return;
                /* A Chromium process can outlive its last window (background
                   mode). It is not a panel any more, so remove that stale
                   process before opening exactly one fresh window. */
                WriteLog("panel process has no window; clearing stale process");
                KillPanelTree();
            }
            if (panelOpening) return;
            panelOpening = true;
            try
            {
                string url = "http://127.0.0.1:" + port + "/";
                string[] browsers = new string[]
                {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft\\Edge\\Application\\msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft\\Edge\\Application\\msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google\\Chrome\\Application\\chrome.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google\\Chrome\\Application\\chrome.exe")
                };
                string profile = Path.Combine(dataDir, "panel-browser");
                Directory.CreateDirectory(profile);
                foreach (string browser in browsers)
                {
                    if (!File.Exists(browser)) continue;
                    try
                    {
                        var info = new ProcessStartInfo(browser);
                        info.UseShellExecute = false;
                        info.Arguments = "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check --window-size=1080,820";
                        panel = Process.Start(info);
                        if (panel != null)
                        {
                            WatchPanel(panel);
                            WriteLog("panel opened in " + Path.GetFileName(browser));
                            return;
                        }
                    }
                    catch { }
                }
                try
                {
                    panel = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                    if (panel != null) WatchPanel(panel);
                }
                catch { }
            }
            finally { panelOpening = false; }
        }

        private void WatchPanel(Process process)
        {
            process.EnableRaisingEvents = true;
            process.Exited += delegate
            {
                if (panel != process) return;
                panel = null;
                if (quitting) return;
                try
                {
                    tray.ShowBalloonTip(5000, "ATHENA Node is still running",
                        "The panel is closed, but the Node agent and tray icon are still active. Open the panel again from the tray.", ToolTipIcon.Info);
                }
                catch { }
            };
        }

        private void KillPanelTree()
        {
            var process = panel;
            panel = null;
            if (process == null) return;
            try
            {
                if (!process.HasExited)
                {
                    Process.Start(new ProcessStartInfo("taskkill", "/pid " + process.Id + " /t /f") { UseShellExecute = false, CreateNoWindow = true });
                    process.WaitForExit(3000);
                }
            }
            catch { }
        }

        private bool FocusPanel(Process process)
        {
            try
            {
                IntPtr handle = process.MainWindowHandle;
                if (handle == IntPtr.Zero) handle = FindPanelWindow(process.Id);
                if (handle == IntPtr.Zero) handle = FindPanelWindow(0);
                if (handle == IntPtr.Zero) return false;
                ShowWindow(handle, 9);
                SetForegroundWindow(handle);
                return true;
            }
            catch { return false; }
        }

        private static IntPtr FindPanelWindow(int pid)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hwnd, IntPtr lparam)
            {
                if (!IsWindowVisible(hwnd)) return true;
                int owner;
                GetWindowThreadProcessId(hwnd, out owner);
                bool sameProcess = pid != 0 && owner == pid;
                bool sameTitle = pid == 0 && GetWindowText(hwnd).StartsWith("ATHENA Node", StringComparison.OrdinalIgnoreCase);
                if (!sameProcess && !sameTitle) return true;
                found = hwnd;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        private static string GetWindowText(IntPtr hwnd)
        {
            var text = new StringBuilder(512);
            GetWindowText(hwnd, text, text.Capacity);
            return text.ToString();
        }

        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lparam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern int GetWindowThreadProcessId(IntPtr hwnd, out int processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);

        private void WriteLog(string line)
        {
            if (String.IsNullOrEmpty(line)) return;
            try
            {
                File.AppendAllText(logFile, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { }
        }

        private void Quit()
        {
            quitting = true;
            restartTimer.Stop();
            stableTimer.Stop();
            StopChild();
            KillPanelTree();
            try { openEvent.Set(); } catch { }
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (tray != null) tray.Dispose();
                if (marshal != null) marshal.Dispose();
                if (restartTimer != null) restartTimer.Dispose();
                if (stableTimer != null) stableTimer.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
