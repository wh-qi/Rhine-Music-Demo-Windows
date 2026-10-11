// SystemMediaTransportControls：与播放状态双向绑定，提供媒体键、锁屏信息与音量 OSD。
// 控制台进程没有窗口，这里自建一个从不显示的宿主窗口（GetForWindow 需要 HWND），
// 并在专属 STA 线程上跑消息循环 —— SMTC 的回调只有在泵消息时才会派发。
using System.Runtime.InteropServices;
using Windows.Media;

namespace RhineWinService;

internal sealed class Smtc : IDisposable
{
    private const int WmApp = 0x8000;
    private const int WmUpdate = WmApp + 1;
    private const int WmStop = WmApp + 2;
    private const int WsOverlapped = 0x00000000;
    private const int CwUseDefault = unchecked((int)0x80000000);
    private const string ClassName = "RhineMusicSmtcHost";
    private const string AppUserModelId = "com.rhinelab.rhine-music.windows";

    private readonly Action<string> onButton;
    private readonly object gate = new();
    private readonly ManualResetEventSlim ready = new(false);
    private readonly WndProc procedure;

    private Thread? pump;
    private IntPtr window;
    private SystemMediaTransportControls? controls;
    private volatile bool available;

    private string title = "";
    private string artist = "";
    private string album = "";
    private bool hasTrack;
    private bool playing;
    private double position;
    private double duration;
    private bool metadataDirty;
    private bool statusDirty;

    public Smtc(Action<string> onButton)
    {
        this.onButton = onButton;
        procedure = WindowProcedure;
        pump = new Thread(PumpThread) { IsBackground = true, Name = "rhine-smtc" };
        pump.SetApartmentState(ApartmentState.STA);
        pump.Start();
        ready.Wait(8000);
    }

    public bool Available => available;

    private void PumpThread()
    {
        try
        {
            _ = RoInitialize(0); // RO_INIT_SINGLETHREADED
            _ = SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
            var instance = GetModuleHandle(null);
            var definition = new WndClassEx
            {
                cbSize = Marshal.SizeOf<WndClassEx>(),
                style = 0,
                lpfnWndProc = procedure,
                hInstance = instance,
                lpszClassName = ClassName,
            };
            if (RegisterClassEx(ref definition) == 0) throw new InvalidOperationException("无法注册 SMTC 宿主窗口类");
            window = CreateWindowEx(0, ClassName, "Rhine Music", WsOverlapped, CwUseDefault, CwUseDefault, 0, 0, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (window == IntPtr.Zero) throw new InvalidOperationException("无法创建 SMTC 宿主窗口");

            controls = SystemMediaTransportControlsInterop.GetForWindow(window);
            controls.IsEnabled = true;
            controls.IsPlayEnabled = true;
            controls.IsPauseEnabled = true;
            controls.IsNextEnabled = true;
            controls.IsPreviousEnabled = true;
            controls.IsStopEnabled = true;
            controls.PlaybackStatus = MediaPlaybackStatus.Closed;
            controls.ButtonPressed += OnButtonPressed;
            available = true;
        }
        catch (Exception error)
        {
            Program.Diagnostics.Line("[smtc] " + error.Message);
        }
        finally
        {
            ready.Set();
        }

        while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
    }

    private void OnButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
    {
        // 播放与暂停都映射成同一个切换动作：状态由播放器统一裁决，避免重复触发。
        var action = args.Button switch
        {
            SystemMediaTransportControlsButton.Play => "toggle",
            SystemMediaTransportControlsButton.Pause => "toggle",
            SystemMediaTransportControlsButton.Next => "next",
            SystemMediaTransportControlsButton.Previous => "previous",
            SystemMediaTransportControlsButton.Stop => "stop",
            _ => null,
        };
        if (action is not null) onButton(action);
    }

    /// <summary>曲目信息。传空表示当前没有曲目（SMTC 会收起面板）。</summary>
    public void SetTrack(string? title, string? artist, string? album)
    {
        var next = !string.IsNullOrEmpty(title);
        lock (gate)
        {
            if (hasTrack == next && this.title == (title ?? "") && this.artist == (artist ?? "") && this.album == (album ?? "")) return;
            this.title = title ?? "";
            this.artist = artist ?? "";
            this.album = album ?? "";
            hasTrack = next;
            metadataDirty = true;
            statusDirty = true;
        }
        Nudge();
    }

    public void SetPlayback(bool isPlaying)
    {
        lock (gate)
        {
            if (playing == isPlaying) return;
            playing = isPlaying;
            statusDirty = true;
        }
        Nudge();
    }

    public void SetTimeline(double position, double duration)
    {
        lock (gate)
        {
            this.position = position;
            this.duration = duration;
        }
        Nudge();
    }

    private void Nudge()
    {
        if (available && window != IntPtr.Zero) PostMessage(window, WmUpdate, IntPtr.Zero, IntPtr.Zero);
    }

    private void Apply()
    {
        var controls = this.controls;
        if (controls is null) return;
        lock (gate)
        {
            if (metadataDirty)
            {
                metadataDirty = false;
                if (hasTrack)
                {
                    controls.DisplayUpdater.Type = MediaPlaybackType.Music;
                    var music = controls.DisplayUpdater.MusicProperties;
                    music.Title = title;
                    music.Artist = artist;
                    music.AlbumTitle = album;
                }
                else
                {
                    controls.DisplayUpdater.ClearAll();
                }
                controls.DisplayUpdater.Update();
            }
            if (statusDirty)
            {
                statusDirty = false;
                controls.PlaybackStatus = !hasTrack
                    ? MediaPlaybackStatus.Closed
                    : playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;
            }
            var end = Math.Max(0, duration);
            var at = Math.Clamp(position, 0, end);
            try
            {
                controls.UpdateTimelineProperties(new SystemMediaTransportControlsTimelineProperties
                {
                    StartTime = TimeSpan.Zero,
                    EndTime = TimeSpan.FromSeconds(end),
                    Position = TimeSpan.FromSeconds(at),
                    MinSeekTime = TimeSpan.Zero,
                    MaxSeekTime = TimeSpan.FromSeconds(end),
                });
            }
            catch
            {
                // 时间轴更新失败不影响播放。
            }
        }
    }

    private IntPtr WindowProcedure(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == WmUpdate) { Apply(); return IntPtr.Zero; }
        if (message == WmStop) { PostQuitMessage(0); return IntPtr.Zero; }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    public void Dispose()
    {
        if (controls is not null)
        {
            try { controls.ButtonPressed -= OnButtonPressed; controls.IsEnabled = false; } catch { }
            controls = null;
        }
        if (window != IntPtr.Zero)
        {
            PostMessage(window, WmStop, IntPtr.Zero, IntPtr.Zero);
            window = IntPtr.Zero;
        }
        var thread = pump;
        pump = null;
        if (thread is not null && thread.IsAlive) thread.Join(1000);
        available = false;
    }

    /// <summary>
    /// 诊断用：从系统会话管理器读回当前媒体会话，用来验证锁屏／音量 OSD 真能拿到曲目信息。
    /// 这是「读别人」的 API，与上面「发布自己」的 SMTC 是两套接口。
    /// </summary>
    public static async Task<int> DumpCurrentSessionAsync()
    {
        try
        {
            var manager = await Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            var session = manager.GetCurrentSession();
            if (session is null)
            {
                Program.Diagnostics.Line("session=none");
                return 1;
            }
            var properties = await session.TryGetMediaPropertiesAsync();
            var playback = session.GetPlaybackInfo();
            Program.Diagnostics.Line("title=" + properties.Title);
            Program.Diagnostics.Line("artist=" + properties.Artist);
            Program.Diagnostics.Line("album=" + properties.AlbumTitle);
            Program.Diagnostics.Line("status=" + playback.PlaybackStatus);
            return 0;
        }
        catch (Exception error)
        {
            Program.Diagnostics.Line("error=" + error.Message);
            return 1;
        }
    }

    // ---------------- Win32 ----------------

    private delegate IntPtr WndProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClassEx
    {
        public int cbSize;
        public int style;
        [MarshalAs(UnmanagedType.FunctionPtr)] public WndProc lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string? lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public Point pt;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WndClassEx definition);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(int exStyle, string className, string windowName, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetMessage(out Msg message, IntPtr hwnd, uint filterMin, uint filterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Msg message);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DispatchMessage(ref Msg message);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int exitCode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? name);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [DllImport("combase.dll")]
    private static extern int RoInitialize(int apartmentType);
}
