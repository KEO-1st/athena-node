using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

/*
 * ATHENA Node per-user uninstaller.
 *
 * Keeps %LOCALAPPDATA%\ATHENA Node (identity, pairing, settings, logs) unless
 * the person explicitly removes it later. No CMD file is shipped to users.
 */
namespace AthenaNodeUninstall
{
    internal static class Program
    {
        private const string Product = "ATHENA Node";

        [STAThread]
        private static void Main()
        {
            bool silent = false;
            foreach (string arg in Environment.GetCommandLineArgs())
                if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase)) silent = true;

            if (!silent)
            {
                DialogResult answer = MessageBox.Show(
                    "Remove ATHENA Node from this PC?\n\nYour identity, pairing, settings and logs in %LOCALAPPDATA%\\ATHENA Node are kept.",
                    "Uninstall ATHENA Node",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return;
            }

            string target = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            try
            {
                Process.Start(new ProcessStartInfo("taskkill", "/im \"" + Product + ".exe\" /f") { UseShellExecute = false, CreateNoWindow = true });
            }
            catch { }

            try
            {
                string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Product + ".lnk");
                if (File.Exists(desktop)) File.Delete(desktop);
                string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Product);
                if (Directory.Exists(programs)) Directory.Delete(programs, true);
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\ATHENA Node", false);
            }
            catch { }

            try
            {
                string script = "timeout /t 1 /nobreak >nul & rmdir /s /q \"" + target.Replace("\"", "") + "\"";
                Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"), "/d /c " + script) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
            }
            catch
            {
                if (!silent) MessageBox.Show("The program could not schedule its own removal. Delete this folder by hand:\n\n" + target, Product, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }
}
