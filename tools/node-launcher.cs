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
        private const string LauncherMutex = "ATHENA.Node.Launcher.0_3";
        private const string OpenPanelEvent = "ATHENA.Node.OpenPanel.0_3";

        [STAThread]
        private static void Main()
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

                child = new Process();
                child.StartInfo = info;
                child.EnableRaisingEvents = true;
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog(e.Data); };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog(e.Data); };
                child.Exited += delegate(object sender, EventArgs e) { OnChildExit(); };
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
                tray.ShowBalloonTip(6000, "ATHENA Node could not start", error.Message, ToolTipIcon.Error);
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
                    tray.ShowBalloonTip(6000, "ATHENA Node is not answering",
                        "Use the tray menu to open the data folder and read launcher.log.", ToolTipIcon.Warning);
                }
                catch { }
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

        private void OnChildExit()
        {
            /* Process.Exited arrives on a worker thread. Tray and timer calls
               must move back to the WinForms thread. */
            if (marshal.InvokeRequired)
            {
                try { marshal.BeginInvoke((Action)OnChildExit); } catch { }
                return;
            }
            int code = -1;
            try { code = child.ExitCode; } catch { }
            WriteLog("node exited with code " + code);
            child = null;
            if (quitting) return;
            if (code == 76) { Quit(); return; }
            if (code == 75)
            {
                tray.Text = "ATHENA Node · restarting";
                restartTimer.Start();
                return;
            }
            crashCount++;
            if (crashCount <= 3)
            {
                tray.Text = "ATHENA Node · recovering";
                tray.ShowBalloonTip(3000, "ATHENA Node stopped",
                    "Restarting automatically (attempt " + crashCount + " of 3).", ToolTipIcon.Warning);
                restartTimer.Start();
            }
            else
            {
                tray.Text = "ATHENA Node · stopped";
                tray.ShowBalloonTip(6000, "ATHENA Node stopped",
                    "It failed repeatedly. Open the data folder and read launcher.log.", ToolTipIcon.Error);
            }
        }

        private void RestartChild()
        {
            if (quitting) return;
            crashCount = 0;
            StopChild();
            tray.Text = "ATHENA Node · restarting";
            restartTimer.Start();
        }

        private void StopChild()
        {
            try
            {
                if (child != null && !child.HasExited)
                {
                    Process.Start(new ProcessStartInfo("taskkill", "/pid " + child.Id + " /t /f") { UseShellExecute = false, CreateNoWindow = true });
                    child.WaitForExit(5000);
                }
            }
            catch { }
            child = null;
        }

        private void OpenPanel()
        {
            if (quitting) return;
            if (panel != null && !panel.HasExited)
            {
                if (FocusPanel(panel)) return;
                /* The browser process is alive but its window is hidden or
                   minimised. Do not create a second one; tell the person where
                   the panel is instead. */
                tray.ShowBalloonTip(3000, "ATHENA Node panel is open",
                    "Use the taskbar to bring the existing ATHENA Node panel forward.", ToolTipIcon.Info);
                return;
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
                            panel.EnableRaisingEvents = true;
                            panel.Exited += delegate { panel = null; };
                            WriteLog("panel opened in " + Path.GetFileName(browser));
                            return;
                        }
                    }
                    catch { }
                }
                try
                {
                    panel = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                    if (panel != null)
                    {
                        panel.EnableRaisingEvents = true;
                        panel.Exited += delegate { panel = null; };
                    }
                }
                catch { }
            }
            finally { panelOpening = false; }
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
            StopChild();
            try
            {
                if (panel != null && !panel.HasExited) panel.Kill();
            }
            catch { }
            panel = null;
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
            }
            base.Dispose(disposing);
        }
    }
}
