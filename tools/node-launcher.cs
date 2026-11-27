using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/*
 * ATHENA Node desktop launcher.
 *
 * The agent is a Node.js process. This launcher gives the product one Windows
 * face: a single tray identity, one embedded WebView2 window, crash recovery
 * and a clean restart/quit path. A second launch never opens a second panel; it
 * signals the running launcher through a named event and exits quietly.
 *
 * The panel is a real desktop window owned by this process. Closing it hides
 * the window to the tray and says so at that moment; it does not depend on a
 * browser process hand-off or on guessing which Chromium window is ours.
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
        private Form panelForm;
        private WebView2 panelWeb;
        private bool panelReady;
        private bool panelLoading;
        private bool quitting;
        private bool closeAllowed;
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
                tray.Text = "ATHENA Node - starting";
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
                        tray.Text = "ATHENA Node - running";
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
                tray.Text = "ATHENA Node - restarting";
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
                tray.Text = "ATHENA Node - recovering";
                tray.ShowBalloonTip(3500, "ATHENA Node stopped",
                    reason + ". Restarting in " + (crashDelayMs / 1000) + "s (attempt " + crashCount + " of " + MaxCrashRestarts + ").", ToolTipIcon.Warning);
                restartTimer.Interval = crashDelayMs;
                restartTimer.Start();
            }
            else
            {
                tray.Text = "ATHENA Node - stopped";
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
            tray.Text = "ATHENA Node - restarting";
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
            if (panelForm != null && !panelForm.IsDisposed)
            {
                if (panelForm.WindowState == FormWindowState.Minimized) panelForm.WindowState = FormWindowState.Normal;
                panelForm.Show();
                panelForm.WindowState = FormWindowState.Normal;
                panelForm.Activate();
                panelForm.BringToFront();
                if (panelReady && panelWeb != null && panelWeb.CoreWebView2 != null)
                {
                    try { panelWeb.CoreWebView2.Reload(); } catch { }
                }
                return;
            }
            if (panelLoading) return;
            panelLoading = true;
            try
            {
                panelForm = new Form();
                panelForm.Text = "ATHENA Node";
                panelForm.Width = 1180;
                panelForm.Height = 820;
                panelForm.MinimumSize = new Size(760, 560);
                panelForm.StartPosition = FormStartPosition.CenterScreen;
                panelForm.BackColor = Color.FromArgb(11, 12, 18);
                panelForm.Icon = LoadIcon();
                panelForm.ShowInTaskbar = true;

                panelWeb = new WebView2();
                panelWeb.Dock = DockStyle.Fill;
                panelWeb.DefaultBackgroundColor = Color.FromArgb(11, 12, 18);
                panelForm.Controls.Add(panelWeb);

                panelForm.FormClosing += delegate(object sender, FormClosingEventArgs e)
                {
                    if (quitting || closeAllowed) return;
                    if (e.CloseReason == CloseReason.UserClosing)
                    {
                        e.Cancel = true;
                        HidePanel();
                    }
                };
                panelForm.Resize += delegate
                {
                    if (quitting) return;
                    if (panelForm.WindowState == FormWindowState.Minimized)
                    {
                        panelForm.Hide();
                        ShowBackgroundNotice();
                    }
                };
                panelForm.Shown += async delegate { await LoadPanelAsync(); };
                panelForm.Show();
                WriteLog("embedded panel window opened");
            }
            catch (Exception error)
            {
                panelLoading = false;
                WriteLog("panel window failed: " + error);
                MessageBox.Show("The ATHENA Node window could not open.\n\n" + error.Message,
                    "ATHENA Node", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task LoadPanelAsync()
        {
            try
            {
                string profile = Path.Combine(dataDir, "panel-webview");
                Directory.CreateDirectory(profile);
                var environment = await CoreWebView2Environment.CreateAsync(null, profile, null);
                await panelWeb.EnsureCoreWebView2Async(environment);
                var core = panelWeb.CoreWebView2;
                if (core == null) throw new Exception("WebView2 did not create a browser core.");
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsSwipeNavigationEnabled = false;
                core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e)
                {
                    try
                    {
                        string message = e.TryGetWebMessageAsString();
                        if (!String.IsNullOrEmpty(message) && message.IndexOf("hide-panel", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            HidePanel();
                        }
                    }
                    catch { }
                };
                core.Navigate("http://127.0.0.1:" + port + "/");
                panelReady = true;
                panelLoading = false;
                WriteLog("embedded panel loaded (WebView2 " + core.Environment.BrowserVersionString + ")");
            }
            catch (Exception error)
            {
                panelLoading = false;
                panelReady = false;
                WriteLog("WebView2 failed: " + error);
                MessageBox.Show(
                    "ATHENA Node needs the Microsoft WebView2 runtime, which is part of Windows 10/11 but missing or damaged on this PC.\n\n" +
                    error.Message + "\n\nInstall the Evergreen WebView2 Runtime, then start ATHENA Node again.",
                    "ATHENA Node", MessageBoxButtons.OK, MessageBoxIcon.Error);
                try { panelForm.Close(); } catch { }
            }
        }

        private void HidePanel()
        {
            if (panelForm == null || panelForm.IsDisposed) return;
            panelForm.Hide();
            ShowBackgroundNotice();
        }

        private void ShowBackgroundNotice()
        {
            if (quitting) return;
            try
            {
                tray.ShowBalloonTip(4500, "ATHENA Node is still running",
                    "The window is closed, but the agent and tray icon are active. Open ATHENA Node from the tray at any time.", ToolTipIcon.Info);
            }
            catch { }
        }

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
            closeAllowed = true;
            try { if (panelForm != null && !panelForm.IsDisposed) panelForm.Close(); } catch { }
            try { if (panelWeb != null) panelWeb.Dispose(); } catch { }
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
                if (panelWeb != null) panelWeb.Dispose();
                if (panelForm != null) panelForm.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
