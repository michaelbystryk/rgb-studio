// RGB Studio Player: tray app that plays the loops exported by the RGB Studio editor
// straight to the OpenRGB SDK, so the Node editor doesn't need to run.
// Written for the C# 5 compiler that ships with Windows (no $"", ?., =>-members).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("RGB Studio Player")]

namespace RgbStudioPlayer
{
    static class Log
    {
        static readonly object gate = new object();
        public static string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RGB Studio");
        static string path = Path.Combine(Dir, "player.log");

        public static void Reset()
        {
            try { Directory.CreateDirectory(Dir); File.WriteAllText(path, ""); } catch { }
        }

        public static void Write(string msg)
        {
            lock (gate)
            {
                try { File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss") + " " + msg + "\r\n"); } catch { }
            }
        }
    }

    // ---- player.json / player.bin -------------------------------------------------

    class Track
    {
        public int[] Leds;
        public int Frames;
        public int Offset;
    }

    class FileDevice
    {
        public string Name, Location;
        public int LedCount;
        public byte[] Control;   // null = leave the device alone
        public Track[] Tracks;
        public byte[] Still;

        // Runtime state, filled in when matched to an OpenRGB device.
        public int Index = -1;
        public byte[] Pkt;       // ready-to-send UPDATELEDS packet, reused every frame
    }

    class PlayerData
    {
        public double Fps = 20;
        public FileDevice[] Devices;
        public byte[] Bin;

        public static string JsonPath { get { return Path.Combine(Log.Dir, "player.json"); } }
        public static string BinPath { get { return Path.Combine(Log.Dir, "player.bin"); } }

        // Changes whenever either file is rewritten; empty if one is missing.
        public static string Stamp()
        {
            if (!File.Exists(JsonPath) || !File.Exists(BinPath)) return "";
            return File.GetLastWriteTimeUtc(JsonPath).Ticks + "/" + File.GetLastWriteTimeUtc(BinPath).Ticks;
        }

        static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object>; }
        static object Get(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) ? v : null;
        }
        static List<object> List(object o)
        {
            List<object> r = new List<object>();
            System.Collections.IEnumerable e = o as System.Collections.IEnumerable;
            if (e != null && !(o is string)) foreach (object x in e) r.Add(x);
            return r;
        }
        static byte[] B64(object o)
        {
            string s = o as string;
            return s == null ? null : Convert.FromBase64String(s);
        }

        public static PlayerData Load()
        {
            JavaScriptSerializer js = new JavaScriptSerializer();
            js.MaxJsonLength = int.MaxValue;
            Dictionary<string, object> root = Obj(js.DeserializeObject(File.ReadAllText(JsonPath, Encoding.UTF8)));
            PlayerData pd = new PlayerData();
            pd.Bin = File.ReadAllBytes(BinPath);
            object fps = Get(root, "fps");
            pd.Fps = fps == null ? 20 : Convert.ToDouble(fps);
            if (pd.Fps < 1) pd.Fps = 1;
            List<FileDevice> devs = new List<FileDevice>();
            foreach (object o in List(Get(root, "devices")))
            {
                Dictionary<string, object> d = Obj(o);
                if (d == null) continue;
                FileDevice fd = new FileDevice();
                fd.Name = (Get(d, "name") as string) ?? "";
                fd.Location = (Get(d, "location") as string) ?? "";
                fd.LedCount = Convert.ToInt32(Get(d, "ledCount"));
                fd.Control = B64(Get(d, "control"));
                fd.Still = B64(Get(d, "still"));
                List<Track> tracks = new List<Track>();
                foreach (object to in List(Get(d, "tracks")))
                {
                    Dictionary<string, object> t = Obj(to);
                    if (t == null) continue;
                    Track tr = new Track();
                    List<object> leds = List(Get(t, "leds"));
                    tr.Leds = new int[leds.Count];
                    for (int i = 0; i < leds.Count; i++) tr.Leds[i] = Convert.ToInt32(leds[i]);
                    tr.Frames = Convert.ToInt32(Get(t, "frames"));
                    tr.Offset = Convert.ToInt32(Get(t, "offset"));
                    long need = (long)tr.Offset + (long)tr.Frames * tr.Leds.Length * 3;
                    if (tr.Frames <= 0 || tr.Leds.Length == 0 || need > pd.Bin.Length)
                    {
                        Log.Write("skipping bad track on " + fd.Name);
                        continue;
                    }
                    tracks.Add(tr);
                }
                fd.Tracks = tracks.ToArray();
                devs.Add(fd);
            }
            pd.Devices = devs.ToArray();
            return pd;
        }
    }

    // ---- OpenRGB SDK client -------------------------------------------------------

    class Waiter
    {
        public uint Dev, Id;
        public byte[] Body;
        public bool Failed;
        public ManualResetEvent Done = new ManualResetEvent(false);
    }

    class DeviceInfo
    {
        public int Index;
        public string Name, Location;
    }

    class OpenRgbClient
    {
        const uint PKT_COUNT = 0, PKT_DATA = 1, PKT_VERSION = 40, PKT_NAME = 50, PKT_LISTCHANGED = 100;
        public const uint PKT_UPDATELEDS = 1050;
        public const uint PKT_UPDATEMODE = 1101;

        TcpClient tcp;
        NetworkStream stream;
        readonly object sendLock = new object();
        readonly object reqLock = new object();
        readonly List<Waiter> waiters = new List<Waiter>();
        public volatile bool Connected;
        public volatile bool ListChanged;
        public int Protocol;

        public bool Connect()
        {
            tcp = new TcpClient();
            tcp.NoDelay = true;
            IAsyncResult ar = tcp.BeginConnect("127.0.0.1", 6742, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(1500) || !tcp.Connected)
            {
                try { tcp.Close(); } catch { }
                return false;
            }
            tcp.EndConnect(ar);
            stream = tcp.GetStream();
            Connected = true;
            Thread t = new Thread(ReadLoop);
            t.IsBackground = true;
            t.Name = "OpenRGB reader";
            t.Start();
            try
            {
                byte[] resp = Request(0, PKT_VERSION, U32(5), 1000);
                Protocol = (int)Math.Min(5u, BitConverter.ToUInt32(resp, 0));
            }
            catch (Exception) { Protocol = 0; } // servers before protocol 1 never answer
            if (!Connected) return false;
            Send(0, PKT_NAME, Encoding.UTF8.GetBytes("RGB Studio Player\0"));
            return true;
        }

        public void Close()
        {
            Connected = false;
            try { if (tcp != null) tcp.Close(); } catch { }
        }

        static byte[] U32(uint v) { return BitConverter.GetBytes(v); }

        static bool ReadFully(Stream s, byte[] buf, int n)
        {
            int got = 0;
            while (got < n)
            {
                int r = s.Read(buf, got, n - got);
                if (r <= 0) return false;
                got += r;
            }
            return true;
        }

        void ReadLoop()
        {
            byte[] head = new byte[16];
            try
            {
                while (Connected)
                {
                    if (!ReadFully(stream, head, 16)) break;
                    if (head[0] != 'O' || head[1] != 'R' || head[2] != 'G' || head[3] != 'B')
                    {
                        // Out of sync: slide forward a byte at a time until the magic lines up.
                        Buffer.BlockCopy(head, 1, head, 0, 15);
                        if (stream.Read(head, 15, 1) <= 0) break;
                        while (!(head[0] == 'O' && head[1] == 'R' && head[2] == 'G' && head[3] == 'B'))
                        {
                            Buffer.BlockCopy(head, 1, head, 0, 15);
                            if (stream.Read(head, 15, 1) <= 0) return;
                        }
                    }
                    uint dev = BitConverter.ToUInt32(head, 4);
                    uint id = BitConverter.ToUInt32(head, 8);
                    uint size = BitConverter.ToUInt32(head, 12);
                    if (size > 64u * 1024 * 1024) break;
                    byte[] body = new byte[size];
                    if (size > 0 && !ReadFully(stream, body, (int)size)) break;
                    Waiter hit = null;
                    lock (waiters)
                    {
                        for (int i = 0; i < waiters.Count; i++)
                            if (waiters[i].Id == id && waiters[i].Dev == dev) { hit = waiters[i]; waiters.RemoveAt(i); break; }
                    }
                    if (hit != null) { hit.Body = body; hit.Done.Set(); }
                    else if (id == PKT_LISTCHANGED) ListChanged = true;
                }
            }
            catch (Exception) { }
            Connected = false;
            lock (waiters)
            {
                foreach (Waiter w in waiters) { w.Failed = true; w.Done.Set(); }
                waiters.Clear();
            }
        }

        public void Send(uint dev, uint id, byte[] body)
        {
            byte[] pkt = new byte[16 + body.Length];
            pkt[0] = (byte)'O'; pkt[1] = (byte)'R'; pkt[2] = (byte)'G'; pkt[3] = (byte)'B';
            WriteHeader(pkt, dev, id, (uint)body.Length);
            Buffer.BlockCopy(body, 0, pkt, 16, body.Length);
            SendRaw(pkt);
        }

        public static void WriteHeader(byte[] pkt, uint dev, uint id, uint size)
        {
            pkt[0] = (byte)'O'; pkt[1] = (byte)'R'; pkt[2] = (byte)'G'; pkt[3] = (byte)'B';
            Buffer.BlockCopy(U32(dev), 0, pkt, 4, 4);
            Buffer.BlockCopy(U32(id), 0, pkt, 8, 4);
            Buffer.BlockCopy(U32(size), 0, pkt, 12, 4);
        }

        // Header and body go out in one write; a failed write drops the connection.
        public void SendRaw(byte[] pkt)
        {
            if (!Connected) throw new IOException("not connected");
            try
            {
                lock (sendLock) { stream.Write(pkt, 0, pkt.Length); }
            }
            catch (Exception) { Close(); throw; }
        }

        // One request at a time so replies can't be mixed up.
        public byte[] Request(uint dev, uint id, byte[] body, int timeoutMs)
        {
            lock (reqLock)
            {
                Waiter w = new Waiter();
                w.Dev = dev; w.Id = id;
                lock (waiters) { waiters.Add(w); }
                Send(dev, id, body);
                if (!w.Done.WaitOne(timeoutMs))
                {
                    lock (waiters) { waiters.Remove(w); }
                    throw new TimeoutException("OpenRGB did not answer packet " + id);
                }
                if (w.Failed) throw new IOException("connection closed");
                return w.Body;
            }
        }

        static string Str(byte[] b, ref int o)
        {
            int len = BitConverter.ToUInt16(b, o);
            o += 2;
            string s = Encoding.UTF8.GetString(b, o, len).TrimEnd('\0');
            o += len;
            return s;
        }

        // Only the prefix of the controller data is needed to identify a device.
        public List<DeviceInfo> Enumerate()
        {
            List<DeviceInfo> list = new List<DeviceInfo>();
            int count = (int)BitConverter.ToUInt32(Request(0, PKT_COUNT, new byte[0], 5000), 0);
            byte[] arg = Protocol > 0 ? U32((uint)Protocol) : new byte[0];
            for (int i = 0; i < count; i++)
            {
                byte[] b = Request((uint)i, PKT_DATA, arg, 5000);
                int o = 8; // data_size, type
                DeviceInfo d = new DeviceInfo();
                d.Index = i;
                d.Name = Str(b, ref o);
                if (Protocol >= 1) Str(b, ref o); // vendor
                Str(b, ref o);                    // description
                Str(b, ref o);                    // version
                Str(b, ref o);                    // serial
                d.Location = Str(b, ref o);
                list.Add(d);
            }
            return list;
        }
    }

    // ---- playback engine ----------------------------------------------------------

    class Engine
    {
        public volatile int Mode;          // 0 animated, 1 still
        public volatile string Status = "waiting for OpenRGB";

        volatile bool quit;
        Thread thread;
        OpenRgbClient client;
        PlayerData data;
        string stamp = "~";               // never equals a real stamp
        bool paused, needSetup;

        public void Start()
        {
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Name = "Playback";
            thread.Start();
        }

        public void Stop()
        {
            quit = true;
            if (thread != null) thread.Join(4000);
        }

        public static bool EditorRunning()
        {
            TcpClient c = new TcpClient();
            try
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", 6750, null, null);
                return ar.AsyncWaitHandle.WaitOne(200) && c.Connected;
            }
            catch (Exception) { return false; }
            finally { try { c.Close(); } catch { } }
        }

        void Reload()
        {
            string s = PlayerData.Stamp();
            stamp = s;
            data = null;
            needSetup = true;
            if (s == "") { Log.Write("no player files yet"); return; }
            try
            {
                data = PlayerData.Load();
                Log.Write("loaded " + data.Devices.Length + " device(s) at " + data.Fps + " fps");
            }
            catch (Exception e) { Log.Write("could not read player files: " + e.Message); }
        }

        // Matches file devices to OpenRGB indexes by name and location, then puts them in per-LED mode.
        public static void Match(PlayerData d, List<DeviceInfo> devs, bool verbose)
        {
            bool[] used = new bool[devs.Count];
            foreach (FileDevice fd in d.Devices)
            {
                fd.Index = -1;
                for (int i = 0; i < devs.Count; i++)
                {
                    if (used[i] || devs[i].Name != fd.Name || devs[i].Location != fd.Location) continue;
                    used[i] = true;
                    fd.Index = devs[i].Index;
                    break;
                }
                if (fd.Index >= 0)
                {
                    int n = fd.LedCount;
                    fd.Pkt = new byte[16 + 6 + 4 * n];
                    OpenRgbClient.WriteHeader(fd.Pkt, (uint)fd.Index, OpenRgbClient.PKT_UPDATELEDS, (uint)(6 + 4 * n));
                    Buffer.BlockCopy(BitConverter.GetBytes((uint)(6 + 4 * n)), 0, fd.Pkt, 16, 4);
                    Buffer.BlockCopy(BitConverter.GetBytes((ushort)n), 0, fd.Pkt, 20, 2);
                }
                if (verbose)
                    Log.Write((fd.Index >= 0 ? "matched #" + fd.Index : "NOT matched") + ": " + fd.Name + " @ " + fd.Location
                        + (fd.Control == null ? " (control null: left alone)" : ""));
            }
        }

        void Setup()
        {
            List<DeviceInfo> devs = client.Enumerate();
            client.ListChanged = false;
            Match(data, devs, true);
            foreach (FileDevice fd in data.Devices)
                if (fd.Index >= 0 && fd.Control != null) client.Send((uint)fd.Index, OpenRgbClient.PKT_UPDATEMODE, fd.Control);
            needSetup = false;
        }

        // Fills the device's packet from the tracks at the shared clock frame, black elsewhere.
        static void Render(FileDevice fd, byte[] bin, long tick)
        {
            Array.Clear(fd.Pkt, 22, fd.Pkt.Length - 22);
            foreach (Track t in fd.Tracks)
            {
                int frame = (int)(tick % t.Frames);
                int src = t.Offset + frame * t.Leds.Length * 3;
                for (int i = 0; i < t.Leds.Length; i++, src += 3)
                {
                    int led = t.Leds[i];
                    if (led < 0 || led >= fd.LedCount) continue;
                    int dst = 22 + led * 4;
                    fd.Pkt[dst] = bin[src]; fd.Pkt[dst + 1] = bin[src + 1]; fd.Pkt[dst + 2] = bin[src + 2];
                }
            }
        }

        static void FillStill(FileDevice fd)
        {
            Array.Clear(fd.Pkt, 22, fd.Pkt.Length - 22);
            if (fd.Still == null) return;
            int n = Math.Min(fd.LedCount, fd.Still.Length / 3);
            for (int i = 0; i < n; i++)
            {
                fd.Pkt[22 + i * 4] = fd.Still[i * 3];
                fd.Pkt[23 + i * 4] = fd.Still[i * 3 + 1];
                fd.Pkt[24 + i * 4] = fd.Still[i * 3 + 2];
            }
        }

        void SendStill()
        {
            foreach (FileDevice fd in data.Devices)
            {
                if (fd.Index < 0 || fd.Control == null) continue;
                FillStill(fd);
                client.SendRaw(fd.Pkt);
            }
        }

        void Run()
        {
            Stopwatch editorTimer = Stopwatch.StartNew(), fileTimer = Stopwatch.StartNew();
            Stopwatch clock = new Stopwatch(), stillTimer = new Stopwatch();
            Stopwatch retry = new Stopwatch();
            long lastTick = -1;
            bool editor = false, firstRound = true, loggedDown = false;
            Reload();

            while (!quit)
            {
                try
                {
                    if (firstRound || editorTimer.ElapsedMilliseconds >= 1000)
                    {
                        bool now = EditorRunning();
                        editorTimer.Restart();
                        if (now && !editor) { Log.Write("editor is open: pausing"); }
                        if (!now && editor)
                        {
                            Log.Write("editor closed: resuming");
                            for (int i = 0; i < 20 && !quit; i++) Thread.Sleep(100); // it restores a profile on exit
                            Reload();
                            fileTimer.Restart();
                        }
                        editor = now;
                    }
                    firstRound = false;
                    paused = editor;
                    if (paused) { Status = "paused while the editor is open"; Thread.Sleep(100); continue; }

                    if (fileTimer.ElapsedMilliseconds >= 2000)
                    {
                        fileTimer.Restart();
                        if (PlayerData.Stamp() != stamp) Reload();
                    }
                    if (data == null)
                    {
                        Status = "nothing saved yet";
                        Thread.Sleep(200);
                        continue;
                    }

                    if (client == null || !client.Connected)
                    {
                        Status = "waiting for OpenRGB";
                        if (client != null) { client.Close(); client = null; Log.Write("disconnected from OpenRGB"); }
                        if (retry.IsRunning && retry.ElapsedMilliseconds < 3000) { Thread.Sleep(100); continue; }
                        retry.Restart();
                        OpenRgbClient c = new OpenRgbClient();
                        if (c.Connect())
                        {
                            client = c;
                            loggedDown = false;
                            needSetup = true;
                            Log.Write("connected, protocol " + c.Protocol);
                        }
                        else
                        {
                            c.Close();
                            if (!loggedDown) { Log.Write("OpenRGB not reachable, retrying"); loggedDown = true; }
                        }
                        continue;
                    }

                    if (needSetup || client.ListChanged)
                    {
                        Setup();
                        clock.Restart();
                        stillTimer.Reset();
                        lastTick = -1;
                    }

                    bool still = Mode == 1;
                    Status = still ? "still colors" : "playing your look";
                    if (still)
                    {
                        if (!stillTimer.IsRunning || stillTimer.ElapsedMilliseconds >= 1000)
                        {
                            SendStill();
                            stillTimer.Restart();
                        }
                        Thread.Sleep(100);
                        continue;
                    }
                    stillTimer.Reset();

                    double t = clock.Elapsed.TotalSeconds;
                    long tick = (long)(t * data.Fps);
                    if (tick != lastTick)
                    {
                        lastTick = tick;
                        foreach (FileDevice fd in data.Devices)
                        {
                            if (fd.Index < 0 || fd.Control == null) continue;
                            Render(fd, data.Bin, tick);
                            client.SendRaw(fd.Pkt);
                        }
                    }
                    double wait = ((tick + 1) / data.Fps - clock.Elapsed.TotalSeconds) * 1000;
                    Thread.Sleep(wait < 1 ? 1 : (wait > 50 ? 50 : (int)wait));
                }
                catch (Exception e)
                {
                    Log.Write("error: " + e.Message);
                    if (client != null) client.Close();
                    Thread.Sleep(500);
                }
            }

            // Leave the lights on the still colors, unless the editor owns them.
            try
            {
                if (!paused && client != null && client.Connected && data != null)
                {
                    foreach (FileDevice fd in data.Devices)
                        if (fd.Index >= 0 && fd.Control != null) client.Send((uint)fd.Index, OpenRgbClient.PKT_UPDATEMODE, fd.Control);
                    SendStill();
                    Thread.Sleep(100);
                }
            }
            catch (Exception e) { Log.Write("error on exit: " + e.Message); }
            if (client != null) client.Close();
        }
    }

    // ---- tray UI ------------------------------------------------------------------

    class TrayApp : ApplicationContext
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunName = "RGB Studio Player";
        const string PrefKey = @"Software\RGB Studio\Player";

        readonly NotifyIcon tray = new NotifyIcon();
        readonly Engine engine = new Engine();
        readonly Control dispatcher = new Control();
        readonly ManualResetEvent stopQuitListener = new ManualResetEvent(false);
        Thread quitListener;
        bool quitting;
        MenuItem animated, still, startup, updates;

        // Lets native menus follow the Windows dark/light setting, as other tray menus do. These
        // uxtheme exports have no names, only ordinals; they exist on Windows 10 1903 and later.
        [DllImport("uxtheme.dll", EntryPoint = "#135")] static extern int SetPreferredAppMode(int mode);
        [DllImport("uxtheme.dll", EntryPoint = "#136")] static extern void FlushMenuThemes();
        static void FollowSystemTheme()
        {
            try { SetPreferredAppMode(1); FlushMenuThemes(); } // 1 = allow dark
            catch (Exception) { } // older Windows: light menus
        }
        readonly System.Windows.Forms.Timer ui = new System.Windows.Forms.Timer();
        string shownStatus = "";

        public TrayApp(EventWaitHandle quitSignal)
        {
            // A hidden control gives background work a UI-thread dispatcher before the loop starts.
            dispatcher.CreateControl();
            int mode = 0;
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(PrefKey))
                    if (k != null) mode = Convert.ToInt32(k.GetValue("Mode", 0));
            }
            catch (Exception) { }
            engine.Mode = mode == 1 ? 1 : 0;

            // A native menu, so it looks like the other tray menus and stays sharp when scaled.
            // The bold default item is what double-clicking the icon does.
            FollowSystemTheme();
            MenuItem open = new MenuItem("Open editor", delegate { OpenEditor(); });
            open.DefaultItem = true;
            animated = new MenuItem("Play saved look", delegate { SetMode(0); });
            still = new MenuItem("Show still colors", delegate { SetMode(1); });
            animated.RadioCheck = still.RadioCheck = true;
            updates = new MenuItem("Check for updates", delegate { CheckForUpdates(); });
            startup = new MenuItem("Start with Windows", delegate { ToggleStartup(); });
            ContextMenu menu = new ContextMenu(new MenuItem[] {
                open, new MenuItem("-"), animated, still, new MenuItem("-"), updates, startup, new MenuItem("Exit", delegate { Quit(); }),
            });
            menu.Popup += delegate { startup.Checked = StartupOn(); };
            RefreshChecks();

            tray.Icon = MakeIcon();
            tray.ContextMenu = menu;
            tray.DoubleClick += delegate { OpenEditor(); };
            tray.Text = "RGB Studio — waiting for OpenRGB";
            tray.Visible = true;

            ui.Interval = 1000;
            ui.Tick += delegate { UpdateTip(); };
            ui.Start();
            engine.Start();

            quitListener = new Thread(delegate()
            {
                if (WaitHandle.WaitAny(new WaitHandle[] { quitSignal, stopQuitListener }) == 0)
                    OnUiThread(Quit);
            });
            quitListener.IsBackground = true;
            quitListener.Name = "Quit listener";
            quitListener.Start();
        }

        void OnUiThread(MethodInvoker action)
        {
            try
            {
                dispatcher.BeginInvoke((MethodInvoker)delegate { if (!quitting) action(); });
            }
            catch (InvalidOperationException) { } // The tray is already closing.
        }

        void CheckForUpdates()
        {
            updates.Enabled = false;
            Thread worker = new Thread(delegate()
            {
                try
                {
                    // Only contact GitHub when asked; leave normal startup entirely offline.
                    ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                    Version current = Assembly.GetExecutingAssembly().GetName().Version;
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/michaelbystryk/rgb-studio/releases/latest");
                    request.UserAgent = "RGBStudio/" + current.ToString(3);
                    request.Accept = "application/vnd.github+json";
                    request.Timeout = 10000;
                    request.ReadWriteTimeout = 10000;
                    Dictionary<string, object> release;
                    using (WebResponse response = request.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                        release = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());

                    object tagValue, urlValue;
                    if (release == null || !release.TryGetValue("tag_name", out tagValue) ||
                        !release.TryGetValue("html_url", out urlValue))
                        throw new InvalidDataException("The release is missing its version or download page.");
                    string tag = tagValue as string;
                    if (tag == null) throw new InvalidDataException("The release version is missing.");
                    tag = tag.Trim();
                    if (tag.StartsWith("v", StringComparison.OrdinalIgnoreCase)) tag = tag.Substring(1);
                    Version latest;
                    if (!Version.TryParse(tag, out latest)) throw new InvalidDataException("Unrecognized release version: " + tag);
                    // Version treats an omitted fourth component as -1; releases use three components.
                    latest = new Version(latest.Major, latest.Minor, Math.Max(0, latest.Build), Math.Max(0, latest.Revision));
                    Uri page;
                    if (!Uri.TryCreate(urlValue as string, UriKind.Absolute, out page) || page.Scheme != "https" ||
                        !String.Equals(page.Host, "github.com", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("The release download page is invalid.");

                    OnUiThread(delegate
                    {
                        updates.Enabled = true;
                        if (latest.CompareTo(current) > 0)
                        {
                            if (MessageBox.Show("RGB Studio " + tag + " is available. Open the download page?", "RGB Studio",
                                MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                            {
                                try { Process.Start(new ProcessStartInfo(page.AbsoluteUri) { UseShellExecute = true }); }
                                catch (Exception e) { UpdateError(e); }
                            }
                        }
                        else MessageBox.Show("You have the latest version (" + current.ToString(3) + ").", "RGB Studio",
                            MessageBoxButtons.OK, MessageBoxIcon.Information);
                    });
                }
                catch (Exception e)
                {
                    OnUiThread(delegate { updates.Enabled = true; UpdateError(e); });
                }
            });
            worker.IsBackground = true;
            worker.Name = "Update check";
            worker.Start();
        }

        void UpdateError(Exception error)
        {
            Log.Write("update check failed: " + error.Message);
            MessageBox.Show("Couldn't check for updates or open the download page. Please check your internet connection and try again.",
                "RGB Studio", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // Drawn at the tray's own icon size (24 px at 150% scaling), so it isn't resampled.
        static Icon MakeIcon()
        {
            int n = SystemInformation.SmallIconSize.Width;
            using (Bitmap bmp = new Bitmap(n, n))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    Rectangle r = new Rectangle(0, 0, n - 1, n - 1);
                    int d = Math.Max(4, n * 3 / 8);
                    using (GraphicsPath p = new GraphicsPath())
                    {
                        p.AddArc(r.X, r.Y, d, d, 180, 90);
                        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
                        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                        p.CloseFigure();
                        using (LinearGradientBrush b = new LinearGradientBrush(new Rectangle(0, 0, n, n),
                            ColorTranslator.FromHtml("#ff2bd6"), ColorTranslator.FromHtml("#4a6cff"), 45f))
                            g.FillPath(b, p);
                    }
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        void UpdateTip()
        {
            string s = engine.Status;
            if (s == shownStatus) return;
            shownStatus = s;
            tray.Text = "RGB Studio — " + s; // NotifyIcon caps this at 63 chars
        }

        void RefreshChecks()
        {
            animated.Checked = engine.Mode == 0;
            still.Checked = engine.Mode == 1;
            startup.Checked = StartupOn();
        }

        void SetMode(int m)
        {
            engine.Mode = m;
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(PrefKey)) k.SetValue("Mode", m, RegistryValueKind.DWord);
            }
            catch (Exception e) { Log.Write("could not save mode: " + e.Message); }
            RefreshChecks();
        }

        static bool StartupOn()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
                    return k != null && k.GetValue(RunName) != null;
            }
            catch (Exception) { return false; }
        }

        void ToggleStartup()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (k.GetValue(RunName) != null) k.DeleteValue(RunName, false);
                    else k.SetValue(RunName, "\"" + Application.ExecutablePath + "\"");
                }
            }
            catch (Exception e) { Log.Write("could not change startup: " + e.Message); }
            RefreshChecks();
        }

        void OpenEditor()
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            // The launcher runs the editor without a console window.
            string launcher = Path.Combine(exeDir, "RGBStudio.exe");
            if (File.Exists(launcher))
            {
                try
                {
                    ProcessStartInfo lp = new ProcessStartInfo(launcher);
                    lp.WorkingDirectory = exeDir;
                    Process.Start(lp);
                    return;
                }
                catch (Exception e) { Log.Write("could not start launcher: " + e.Message); }
            }
            string dir = null;
            DirectoryInfo parent = Directory.GetParent(exeDir);
            if (parent != null && File.Exists(Path.Combine(parent.FullName, "start.cmd"))) dir = parent.FullName;
            else if (File.Exists(Path.Combine(exeDir, "start.cmd"))) dir = exeDir;
            if (dir == null)
            {
                tray.ShowBalloonTip(4000, "RGB Studio", "Couldn't find start.cmd next to the player.", ToolTipIcon.Warning);
                return;
            }
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + Path.Combine(dir, "start.cmd") + "\"\"");
                psi.WorkingDirectory = dir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch (Exception e)
            {
                Log.Write("could not start editor: " + e.Message);
                tray.ShowBalloonTip(4000, "RGB Studio", "Couldn't start the editor.", ToolTipIcon.Warning);
            }
        }

        void Quit()
        {
            if (quitting) return;
            quitting = true;
            stopQuitListener.Set();
            if (quitListener != null) quitListener.Join();
            ui.Stop();
            engine.Stop();
            tray.Visible = false;
            tray.Dispose();
            dispatcher.Dispose();
            stopQuitListener.Dispose();
            ExitThread();
        }
    }

    static class Program
    {
        const string QuitEventName = "RGBStudioPlayerQuit";

        static int AskToQuit()
        {
            try
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting(QuitEventName)) signal.Set();
                // Let the same Quit() path finish before the installer replaces the executable.
                using (Mutex running = Mutex.OpenExisting("RGBStudioPlayer"))
                {
                    bool owned = false;
                    try
                    {
                        try { owned = running.WaitOne(4500); }
                        catch (AbandonedMutexException) { owned = true; }
                    }
                    finally { if (owned) running.ReleaseMutex(); }
                }
            }
            catch (Exception) { } // No player running, or it has already finished quitting.
            return 0;
        }

        // Connects, enumerates and logs the matching without sending any mode or color packets.
        static int Check()
        {
            OpenRgbClient c = new OpenRgbClient();
            try
            {
                if (!c.Connect()) { Log.Write("check: OpenRGB not reachable"); return 1; }
                Log.Write("connected, protocol " + c.Protocol);
                List<DeviceInfo> devs = c.Enumerate();
                foreach (DeviceInfo d in devs) Log.Write("openrgb #" + d.Index + ": " + d.Name + " @ " + d.Location);
                string s = PlayerData.Stamp();
                if (s == "") { Log.Write("check: no player files"); return 0; }
                PlayerData pd = PlayerData.Load();
                Log.Write("loaded " + pd.Devices.Length + " device(s) at " + pd.Fps + " fps");
                Engine.Match(pd, devs, true);
                return 0;
            }
            catch (Exception e) { Log.Write("check failed: " + e.Message); return 1; }
            finally { c.Close(); }
        }

        [STAThread]
        static int Main(string[] args)
        {
            foreach (string a in args)
                if (a == "--quit") return AskToQuit();

            foreach (string a in args)
                if (a == "--check") { Log.Reset(); return Check(); }

            bool created;
            using (EventWaitHandle quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName))
            using (Mutex m = new Mutex(true, "RGBStudioPlayer", out created))
            {
                if (!created) return 0; // second launch must not clobber the log
                Log.Reset();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp(quitSignal));
                GC.KeepAlive(m);
            }
            return 0;
        }
    }
}
