using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

/*
 * ATHENA Node Windows installer.
 *
 * The portable package is embedded as payload.zip at build time, so this is a
 * single self-contained Setup.exe. It installs under LOCALAPPDATA (no admin
 * prompt), preserves the separate identity/data directory, creates shortcuts,
 * and registers a normal uninstall entry. No Node.js or WinGet is required.
 */
namespace AthenaNodeSetup
{
    internal static class Program
    {
        private const string Product = "ATHENA Node";

        [STAThread]
        private static void Main()
        {
            try
            {
                string[] args = Environment.GetCommandLineArgs();
                string target = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs",
                    Product);
                bool silent = false;
                bool noLaunch = false;
                bool noShortcuts = false;
                foreach (string arg in args)
                {
                    if (arg.StartsWith("--dir=", StringComparison.OrdinalIgnoreCase)) target = arg.Substring(6).Trim('"');
                    if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase)) silent = true;
                    if (arg.Equals("--no-launch", StringComparison.OrdinalIgnoreCase)) noLaunch = true;
                    if (arg.Equals("--no-shortcuts", StringComparison.OrdinalIgnoreCase)) noShortcuts = true;
                }
                Directory.CreateDirectory(target);

                /* An in-place update must not leave the old launcher running. */
                try
                {
                    Process.Start(new ProcessStartInfo("taskkill", "/im \"" + Product + ".exe\" /f") { UseShellExecute = false, CreateNoWindow = true });
                }
                catch { }

                using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                {
                    if (payload == null) throw new Exception("The installer payload is missing. Download Setup.exe again.");
                    using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                    {
                        foreach (ZipArchiveEntry entry in archive.Entries)
                        {
                            string destination = Path.GetFullPath(Path.Combine(target, entry.FullName));
                            if (!destination.StartsWith(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
                                throw new Exception("The installer payload contains an unsafe path.");
                            if (String.IsNullOrEmpty(entry.Name))
                            {
                                Directory.CreateDirectory(destination);
                                continue;
                            }
                            Directory.CreateDirectory(Path.GetDirectoryName(destination));
                            entry.ExtractToFile(destination, true);
                        }
                    }
                }

                string launcher = Path.Combine(target, Product + ".exe");
                if (!File.Exists(launcher)) throw new Exception("The package did not contain " + Product + ".exe.");

                string version = "0.2.0";
                try { version = File.ReadAllText(Path.Combine(target, "VERSION")).Trim(); } catch { }

                if (!noShortcuts)
                {
                    CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Product + ".lnk"), launcher, target);
                    string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Product);
                    Directory.CreateDirectory(programs);
                    CreateShortcut(Path.Combine(programs, Product + ".lnk"), launcher, target);
                    CreateShortcut(Path.Combine(programs, "Uninstall " + Product + ".lnk"), Path.Combine(target, "Uninstall " + Product + ".cmd"), target);
                    using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\ATHENA Node"))
                    {
                        if (key != null)
                        {
                            key.SetValue("DisplayName", Product);
                            key.SetValue("DisplayVersion", version);
                            key.SetValue("Publisher", "ATHENA");
                            key.SetValue("InstallLocation", target);
                            key.SetValue("DisplayIcon", launcher);
                            key.SetValue("UninstallString", "\"" + Path.Combine(target, "Uninstall " + Product + ".cmd") + "\"");
                        }
                    }
                }

                if (!silent)
                {
                    MessageBox.Show(
                        Product + " " + version + " is installed.\n\n" +
                        "It will start now. Pair it from the Hub: NODES → SCAN → LINK.\n" +
                        "Your identity and logs stay in %LOCALAPPDATA%\\ATHENA Node and survive updates.",
                        Product,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }

                if (!noLaunch) Process.Start(new ProcessStartInfo(launcher) { WorkingDirectory = target, UseShellExecute = true });
            }
            catch (Exception error)
            {
                MessageBox.Show("ATHENA Node could not be installed:\n\n" + error.Message, Product + " setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void CreateShortcut(string file, string target, string workingDirectory)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(file);
                shortcut.TargetPath = target;
                shortcut.WorkingDirectory = workingDirectory;
                shortcut.Description = Product;
                shortcut.Save();
            }
            catch { }
        }
    }
}
