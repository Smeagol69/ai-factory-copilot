using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            string node = Path.Combine(root, "runtime", "node", "node.exe");
            string script = Path.Combine(root, "scripts", "start-app.mjs");
            if (!File.Exists(node) || !File.Exists(script))
                throw new Exception("Keep Copilot.exe inside its project folder with runtime and scripts.");
            var start = new ProcessStartInfo(node, "\"" + script + "\"") {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var process = Process.Start(start))
            {
                if (!process.WaitForExit(20000))
                {
                    process.Kill();
                    throw new Exception("Startup is taking too long. Inspect state\\app\\stderr.log.");
                }
                string output = process.StandardOutput.ReadToEnd();
                string errors = process.StandardError.ReadToEnd();
                if (process.ExitCode != 0) throw new Exception(errors);
                Match match = Regex.Match(output, "http://127\\.0\\.0\\.1:[0-9]{4,5}/");
                if (!match.Success) throw new Exception("Startup returned no local application address.");
                Process.Start(new ProcessStartInfo(match.Value) { UseShellExecute = true });
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Copilot needs attention", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
