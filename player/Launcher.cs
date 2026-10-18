// RGB Studio launcher: runs the Node editor server with no console window, so Task Manager
// shows "RGB Studio" with the logo instead of a minimised "Node.js JavaScript Runtime".
// Written for the C# 5 compiler that ships with Windows (no $"", ?., =>-members).
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("RGB Studio")]
[assembly: AssemblyProduct("RGB Studio")]
[assembly: AssemblyCompany("Michael Bystryk")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace RgbStudioLauncher
{
    // Same log folder as the player, a different file. Started fresh each launch.
    static class Log
    {
        static readonly object gate = new object();
        static string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RGB Studio");
        static string path = Path.Combine(dir, "editor.log");

        public static void Reset()
        {
            try { Directory.CreateDirectory(dir); File.WriteAllText(path, ""); } catch { }
        }

        public static void Write(string msg)
        {
            lock (gate)
            {
                try { File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss") + " " + msg + "\r\n"); } catch { }
            }
        }
    }

    // A Windows job holding just node, killed when the last handle to it closes, which
    // happens when this launcher is ended. That way ending "RGB Studio" in Task Manager
    // also ends node. What node starts (the browser, the tray player) stays out of it.
    static class Job
    {
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        const int ExtendedLimitInformation = 9;
        const uint KillOnJobClose = 0x2000;
        const uint SilentBreakaway = 0x1000; // node's own children aren't put in the job

        static IntPtr job = IntPtr.Zero;   // never closed: it lives as long as the launcher

        public static void Add(Process p)
        {
            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return;
                ExtendedLimits info = new ExtendedLimits();
                info.Basic.LimitFlags = KillOnJobClose | SilentBreakaway;
                if (!SetInformationJobObject(job, ExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimits)))) return;
                if (!AssignProcessToJobObject(job, p.Handle)) Log.Write("could not add node to the job: error " + Marshal.GetLastWin32Error());
            }
            catch (Exception e) { Log.Write("job object failed: " + e.Message); }
        }
    }

    static class Launcher
    {
        const string Title = "RGB Studio";

        static void Say(string text)
        {
            MessageBox.Show(text, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        // The RGB Studio folder: the parent of player\ if it has server.js, else next to the exe.
        static string FindRoot()
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            DirectoryInfo parent = Directory.GetParent(exeDir);
            if (parent != null && File.Exists(Path.Combine(parent.FullName, "server.js"))) return parent.FullName;
            return exeDir;
        }

        static string FindNode()
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in path.Split(';'))
            {
                try
                {
                    string dir = part.Trim().Trim('"');
                    if (dir.Length == 0) continue;
                    string file = Path.Combine(dir, "node.exe");
                    if (File.Exists(file)) return file;
                }
                catch { }
            }
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe");
            return File.Exists(fallback) ? fallback : null;
        }

        static string Quote(string arg)
        {
            return arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0 ? arg : "\"" + arg.Replace("\"", "\\\"") + "\"";
        }

        // Starts a hidden child with its output appended to the log.
        static Process StartHidden(ProcessStartInfo psi)
        {
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            Process p = Process.Start(psi);
            DataReceivedEventHandler onLine = delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null && e.Data.Length > 0) Log.Write(e.Data);
            };
            p.OutputDataReceived += onLine;
            p.ErrorDataReceived += onLine;
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        [STAThread]
        static int Main(string[] args)
        {
            Log.Reset();
            string root = FindRoot();
            Log.Write("launcher started in " + root);

            string node = FindNode();
            if (node == null)
            {
                Log.Write("node.exe not found");
                Say("RGB Studio needs Node.js 20 or newer to run the editor, and couldn't find it.\n\n" +
                    "Go to nodejs.org, download the Windows installer (.msi) for the LTS version and keep the default options. " +
                    "If it still can't be found right after installing, sign out of Windows and back in.\n\n" +
                    "The README has the steps, including a one-line PowerShell install.");
                return 1;
            }
            Log.Write("using " + node);

            if (!Directory.Exists(Path.Combine(root, "node_modules\\three")))
            {
                Log.Write("installing dependencies");
                int code = 1;
                try
                {
                    ProcessStartInfo ni = new ProcessStartInfo("cmd.exe", "/c npm install --omit=dev");
                    ni.WorkingDirectory = root;
                    Process npm = StartHidden(ni);
                    npm.WaitForExit();
                    code = npm.ExitCode;
                }
                catch (Exception e) { Log.Write("npm failed to start: " + e.Message); }
                if (code != 0 || !Directory.Exists(Path.Combine(root, "node_modules\\three")))
                {
                    Log.Write("npm install failed (" + code + ")");
                    Say("RGB Studio couldn't install its dependencies. Check your internet connection and try again.\n\nDetails are in %APPDATA%\\RGB Studio\\editor.log.");
                    return 1;
                }
            }

            StringBuilder a = new StringBuilder("server.js --open");
            foreach (string arg in args) a.Append(' ').Append(Quote(arg));

            Process server;
            try
            {
                ProcessStartInfo si = new ProcessStartInfo(node, a.ToString());
                si.WorkingDirectory = root;
                server = StartHidden(si);
            }
            catch (Exception e)
            {
                Log.Write("could not start node: " + e.Message);
                Say("RGB Studio couldn't start the editor: " + e.Message);
                return 1;
            }
            Job.Add(server);

            // Stay here until the server is done. If RGB Studio was already running, it opens the
            // browser and exits 0 right away, and so do we.
            server.WaitForExit();
            Log.Write("editor exited with code " + server.ExitCode);
            return server.ExitCode;
        }
    }
}
