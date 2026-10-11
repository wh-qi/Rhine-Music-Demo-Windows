// WASAPI 输出：独占优先、逐曲采样率与位深协商、失败自动回退共享。
// 渲染线程从 Scheduler 拉取样本，槽位切换发生在缓冲内部，因此接缝精确到样本。
using System.Runtime.InteropServices;

namespace RhineWinService;

internal sealed class AudioDeviceInfo
{
    public required string Id { get; init; }
    public required string Name { get; init; }
}

internal sealed class WasapiOutput : IDisposable, IMMNotificationClient
{
    private readonly object gate = new();
    private readonly Scheduler scheduler = new(16384, 8);
    private readonly List<AudioDeviceInfo> devices = [];
    private readonly Dictionary<string, string> endpointByIndex = [];
    private readonly Dictionary<string, string> nameByIndex = [];

    private IAudioClient? client;
    private IAudioRenderClient? renderClient;
    private IntPtr eventHandle = IntPtr.Zero;
    private Thread? renderThread;
    private volatile bool renderStop;
    private IMMDeviceEnumerator? enumerator;
    private volatile bool deviceListDirty = true;

    private WavFormat clientFormat = new()
    {
        FormatTag = WAVEFORMATEX.WAVE_FORMAT_EXTENSIBLE,
        Channels = 2,
        SampleRate = 44100,
        BitsPerSample = 16,
        ValidBits = 16,
        IsFloat = false,
    };

    private float[] mixBuffer = [];
    private byte[] outputBytes = [];
    private uint bufferFrames;
    private string shareMode = "shared";

    private bool negotiated;
    private string deviceId = "default";
    private string? boundEndpoint;
    private string? lastError;
    private bool clientRunning;

    public WasapiOutput()
    {
        try
        {
            enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            enumerator.RegisterEndpointNotificationCallback(this);
        }
        catch
        {
            enumerator = null;
        }
        RefreshDevices();
    }

    public bool BitPerfect
    {
        get => scheduler.BitPerfect;
        set => scheduler.BitPerfect = value;
    }

    /// <summary>SMTC 由 Program 注入；没有它时媒体键与锁屏信息自动缺省，不影响播放。</summary>
    public Smtc? Smtc { get; set; }

    private (string Title, string Artist, string Album) metadata;

    /// <summary>每条命令开头清一次错误，与该条命令产生的提示一一对应（对齐 Swift 的 command 开头）。</summary>
    public void ClearError() => lastError = null;

    public void RefreshDevices()
    {
        var list = new List<AudioDeviceInfo>();
        var map = new Dictionary<string, string>();
        var names = new Dictionary<string, string>();
        try
        {
            if (enumerator is not null &&
                enumerator.EnumAudioEndpoints(DataFlow.Render, DeviceState.Active, out var collection) == 0 &&
                collection.GetCount(out var count) == 0)
            {
                for (var index = 0; index < count; index++)
                {
                    if (collection.Item(index, out var device) != 0) continue;
                    if (device.GetId(out var endpoint) != 0 || string.IsNullOrEmpty(endpoint)) continue;
                    var indexText = index.ToString();
                    var name = FriendlyName(device) ?? "Audio output";
                    map[indexText] = endpoint;
                    names[indexText] = name;
                    list.Add(new AudioDeviceInfo { Id = indexText, Name = name });
                }
            }
        }
        catch
        {
            // 枚举失败时保持空列表，命令层会给出明确错误。
        }
        devices.Clear();
        devices.AddRange(list);
        endpointByIndex.Clear();
        nameByIndex.Clear();
        foreach (var pair in map) endpointByIndex[pair.Key] = pair.Value;
        foreach (var pair in names) nameByIndex[pair.Key] = pair.Value;
        deviceListDirty = false;
    }

    private static string? FriendlyName(IMMDevice device)
    {
        if (device.OpenPropertyStore(0, out var store) != 0) return null;
        var key = WasapiNative.PkeyDeviceFriendlyName;
        if (store.GetValue(ref key, out var value) != 0) return null;
        try
        {
            if (value.vt != PropVariant.VT_LPWSTR || value.pointerValue == IntPtr.Zero) return null;
            var text = Marshal.PtrToStringUni(value.pointerValue);
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }
        finally
        {
            WasapiNative.PropVariantClear(ref value);
        }
    }

    public List<AudioDeviceInfo> Devices()
    {
        lock (gate)
        {
            RefreshDevices();
            return [.. devices];
        }
    }

    private bool EndpointStillPresent(string endpoint)
    {
        RefreshDevices();
        return endpointByIndex.ContainsValue(endpoint);
    }

    private IMMDevice? ResolveEndpoint(string id, out string? endpointId)
    {
        endpointId = null;
        if (enumerator is null)
        {
            lastError = "系统默认输出设备不可用";
            return null;
        }
        if (id == "default")
        {
            if (enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia, out var device) != 0)
            {
                lastError = "系统默认输出设备不可用";
                return null;
            }
            device.GetId(out endpointId!);
            return device;
        }
        if (deviceListDirty) RefreshDevices();
        if (!endpointByIndex.TryGetValue(id, out endpointId))
        {
            lastError = "所选输出设备已断开，请重新选择";
            return null;
        }
        if (enumerator.GetDevice(endpointId!, out var resolved) != 0)
        {
            lastError = "所选输出设备已断开，请重新选择";
            return null;
        }
        return resolved;
    }

    private static IntPtr AllocFormat(WavFormat format)
    {
        var extensible = format.Channels > 2 || format.BitsPerSample > 16;
        if (!extensible)
        {
            var plain = new WAVEFORMATEX
            {
                wFormatTag = format.IsFloat ? WAVEFORMATEX.WAVE_FORMAT_IEEE_FLOAT : WAVEFORMATEX.WAVE_FORMAT_PCM,
                nChannels = format.Channels,
                nSamplesPerSec = format.SampleRate,
                wBitsPerSample = format.BitsPerSample,
                nBlockAlign = (ushort)format.BlockAlign,
                nAvgBytesPerSec = format.SampleRate * format.BlockAlign,
                cbSize = 0,
            };
            var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<WAVEFORMATEX>());
            Marshal.StructureToPtr(plain, pointer, false);
            return pointer;
        }
        var full = new WAVEFORMATEXTENSIBLE
        {
            Format = new WAVEFORMATEX
            {
                wFormatTag = WAVEFORMATEX.WAVE_FORMAT_EXTENSIBLE,
                nChannels = format.Channels,
                nSamplesPerSec = format.SampleRate,
                wBitsPerSample = format.BitsPerSample,
                nBlockAlign = (ushort)format.BlockAlign,
                nAvgBytesPerSec = format.SampleRate * format.BlockAlign,
                cbSize = 22,
            },
            wValidBitsPerSample = format.ValidBits,
            dwChannelMask = format.Channels switch { 1 => 0x4u, 2 => 0x3u, _ => 0x3Fu },
            SubFormat = format.IsFloat ? AudioSubType.IeeeFloat : AudioSubType.Pcm,
        };
        var fullPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WAVEFORMATEXTENSIBLE>());
        Marshal.StructureToPtr(full, fullPointer, false);
        return fullPointer;
    }

    /// <summary>逐曲协商：独占优先用缓存的原生格式；不支持时回退共享并由引擎转换格式。</summary>
    private void OpenClient(string requestedDevice, WavFormat format)
    {
        CloseClient();
        lastError = null;
        var endpoint = ResolveEndpoint(requestedDevice, out var endpointId)
            ?? throw new AudioCommandException(lastError ?? "所选输出设备已断开，请重新选择");
        var audio = ActivateClient(endpoint);

        shareMode = "shared";
        var native = AllocFormat(format);
        try
        {
            var exclusiveStatus = audio.IsFormatSupported(ShareMode.Exclusive, native, out var closest);
            if (closest != IntPtr.Zero) Marshal.FreeCoTaskMem(closest);

            var exclusiveReady = false;
            if (exclusiveStatus == 0)
            {
                var (initialize, resolved) = TryExclusiveInitialize(endpoint, audio, native, format);
                audio = resolved;
                if (initialize == 0) exclusiveReady = true;
                else lastError = initialize switch
                {
                    AudioClientError.DeviceInUse => "输出设备已被其他程序独占",
                    AudioClientError.ExclusiveModeNotAllowed =>
                        "系统未允许独占控制该设备，请在「声音设置 → 设备属性 → 高级」中勾选「允许应用程序独占控制该设备」",
                    _ => $"独占模式初始化失败（{WasapiNative.Describe(initialize)}）",
                };
            }
            else
            {
                lastError = exclusiveStatus switch
                {
                    AudioClientError.DeviceInUse => "输出设备已被其他程序独占",
                    AudioClientError.ExclusiveModeNotAllowed =>
                        "系统未允许独占控制该设备，请在「声音设置 → 设备属性 → 高级」中勾选「允许应用程序独占控制该设备」",
                    _ => "设备不支持该音频格式的独占输出",
                };
            }

            if (exclusiveReady)
            {
                shareMode = "exclusive";
            }
            else
            {
                var shared = AllocFormat(format);
                try
                {
                    var status = audio.Initialize(
                        ShareMode.Shared,
                        StreamFlags.EventCallback | StreamFlags.AutoConvertPcm | StreamFlags.SrcDefaultQuality,
                        200_000, 0, shared, IntPtr.Zero);
                    if (status != 0)
                        throw new AudioCommandException($"共享模式初始化失败（{WasapiNative.Describe(status)}）");
                }
                finally
                {
                    Marshal.FreeHGlobal(shared);
                }
            }

            client = audio;
            clientFormat = format;
            boundEndpoint = endpointId;
            StartRenderThread(audio, format);
        }
        catch
        {
            if (client is null && Marshal.IsComObject(audio)) Marshal.ReleaseComObject(audio);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(native);
        }
    }

    private static IAudioClient ActivateClient(IMMDevice endpoint)
    {
        var iid = WasapiNative.IidAudioClient;
        if (endpoint.Activate(ref iid, ClsCtx.All, IntPtr.Zero, out var raw) != 0 || raw is not IAudioClient audio)
            throw new AudioCommandException("无法打开所选输出设备的音频客户端");
        return audio;
    }

    /// <summary>
    /// 独占初始化。AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED 是常态：必须按引擎实际给的缓冲帧数
    /// 重算时长，并释放重新激活客户端后再初始化一次（官方 RenderExclusiveEventDriven 的做法）。
    /// </summary>
    private static (int Status, IAudioClient Client) TryExclusiveInitialize(IMMDevice endpoint, IAudioClient audio, IntPtr format, WavFormat wav)
    {
        audio.GetDevicePeriod(out var defaultPeriod, out _);
        var duration = defaultPeriod > 0 ? defaultPeriod : 100_000;
        var status = audio.Initialize(ShareMode.Exclusive, StreamFlags.EventCallback, duration, duration, format, IntPtr.Zero);
        if (status != AudioClientError.BufferSizeNotAligned) return (status, audio);

        audio.GetBufferSize(out var frames);
        var aligned = (long)(10_000_000.0 / wav.SampleRate * frames + 0.5);
        if (Marshal.IsComObject(audio)) Marshal.ReleaseComObject(audio);
        var fresh = ActivateClient(endpoint);
        var retry = fresh.Initialize(ShareMode.Exclusive, StreamFlags.EventCallback, aligned, aligned, format, IntPtr.Zero);
        return (retry, fresh);
    }

    private void StartRenderThread(IAudioClient audio, WavFormat format)
    {
        if (audio.GetBufferSize(out bufferFrames) != 0)
            throw new AudioCommandException("无法读取输出缓冲大小");
        var iid = WasapiNative.IidAudioRenderClient;
        if (audio.GetService(ref iid, out var service) != 0 || service is not IAudioRenderClient render)
            throw new AudioCommandException("无法获取音频渲染接口");
        renderClient = render;

        eventHandle = WasapiNative.CreateEvent(IntPtr.Zero, false, false, IntPtr.Zero);
        if (eventHandle == IntPtr.Zero) throw new AudioCommandException("无法创建音频事件");
        if (audio.SetEventHandle(eventHandle) != 0) throw new AudioCommandException("无法绑定音频事件");

        scheduler.OutputChannels = format.Channels;
        scheduler.OutputSampleRate = format.SampleRate;
        mixBuffer = new float[Math.Min(bufferFrames, 16384) * format.Channels];
        outputBytes = new byte[Math.Min(bufferFrames, 16384) * format.BlockAlign];

        if (audio.Start() != 0) throw new AudioCommandException("无法启动音频输出");
        clientRunning = true;
        // 只有真正协商过格式之后才允许上层显示「实际输出格式」，否则会把默认值当成事实。
        negotiated = true;
        renderStop = false;
        renderThread = new Thread(RenderLoop) { IsBackground = true, Name = "rhine-render" };
        renderThread.Start();
    }

    private void RenderLoop()
    {
        var channels = Math.Max(1, (int)clientFormat.Channels);
        while (!renderStop)
        {
            if (WasapiNative.WaitForSingleObject(eventHandle, 200) == WasapiNative.WaitTimeout) continue;
            if (renderStop) break;
            if (client is not { } audio || renderClient is not { } render) break;
            if (audio.GetCurrentPadding(out var padding) != 0) continue;
            var available = bufferFrames > padding ? bufferFrames - padding : 0;
            var block = (int)Math.Min(available, (uint)(mixBuffer.Length / channels));
            if (block <= 0) continue;
            int produced;
            lock (gate)
            {
                produced = scheduler.Render(mixBuffer.AsSpan(0, block * channels), block);
            }
            _ = produced;
            var bytes = block * clientFormat.BlockAlign;
            Pcm.FromFloat(mixBuffer.AsSpan(0, block * channels), clientFormat, outputBytes.AsSpan(0, bytes));
            if (render.GetBuffer((uint)block, out var target) != 0) continue;
            Marshal.Copy(outputBytes, 0, target, bytes);
            render.ReleaseBuffer((uint)block, 0);
        }
    }

    private void CloseClient()
    {
        renderStop = true;
        if (eventHandle != IntPtr.Zero) WasapiNative.SetEvent(eventHandle);
        var thread = renderThread;
        renderThread = null;
        if (thread is not null && thread.IsAlive) thread.Join(1000);
        if (client is not null)
        {
            try { client.Stop(); } catch { }
        }
        clientRunning = false;
        negotiated = false;
        if (eventHandle != IntPtr.Zero)
        {
            WasapiNative.CloseHandle(eventHandle);
            eventHandle = IntPtr.Zero;
        }
        renderClient = null;
        if (client is not null && Marshal.IsComObject(client)) Marshal.ReleaseComObject(client);
        client = null;
        boundEndpoint = null;
    }

    public void Dispose()
    {
        lock (gate)
        {
            scheduler.Dispose();
            CloseClient();
        }
        try { enumerator?.UnregisterEndpointNotificationCallback(this); } catch { }
        if (enumerator is not null && Marshal.IsComObject(enumerator)) Marshal.ReleaseComObject(enumerator);
        enumerator = null;
    }

    // ---------------- 传输控制 ----------------

    private static WavFormat ClientFormatFor(WavReader reader)
    {
        var source = reader.Format;
        // 规范 5.6：24 位在 WASAPI 里必须声明成 32 位容器 + wValidBitsPerSample=24。
        var container = source.BitsPerSample == 24 ? (ushort)32 : source.BitsPerSample;
        return new WavFormat
        {
            FormatTag = WAVEFORMATEX.WAVE_FORMAT_EXTENSIBLE,
            Channels = (ushort)Math.Max(2, (int)source.Channels),
            SampleRate = source.SampleRate,
            BitsPerSample = container,
            ValidBits = source.BitsPerSample,
            IsFloat = source.IsFloat,
        };
    }

    private static bool SameClientFormat(WavFormat a, WavFormat b) =>
        a.Channels == b.Channels && a.SampleRate == b.SampleRate &&
        a.BitsPerSample == b.BitsPerSample && a.IsFloat == b.IsFloat;

    public void Play(string path, string trackId, double position, string requestedDevice, double? volume, (string Title, string Artist, string Album)? info = null)
    {
        WavReader reader;
        try
        {
            reader = WavReader.Open(path);
        }
        catch (WavException error)
        {
            throw new AudioCommandException(error.Message);
        }
        try
        {
            if (volume is { } value) scheduler.SetDesiredVolume((float)value);
            var wanted = ClientFormatFor(reader);
            if (client is null || !SameClientFormat(clientFormat, wanted) || requestedDevice != deviceId)
            {
                OpenClient(requestedDevice, wanted);
                deviceId = requestedDevice;
            }
            metadata = info ?? default;
            scheduler.Load(reader, trackId, position, play: true);
        }
        catch
        {
            reader.Dispose();
            throw;
        }
    }

    public void Pause() => scheduler.Pause();

    /// <summary>不带 path 的 play：从当前位置续播；已经放到末尾则从头开始。</summary>
    public void Resume()
    {
        var slot = scheduler.Active;
        if (slot.Reader is null) return;
        // 只要重新建立输出客户端即可，Scheduler 里的文件与帧位置都还成立。
        if (client is null || !clientRunning) OpenClient(deviceId, ClientFormatFor(slot.Reader));
        var frame = slot.FrameIndex >= slot.Reader.FrameCount ? 0 : slot.FrameIndex;
        scheduler.ScheduleAt(frame, play: true);
    }

    public void Stop()
    {
        scheduler.Stop();
        CloseClient();
    }

    public void Seek(double position) => scheduler.ScheduleAt((long)(position * scheduler.OutputSampleRate), scheduler.Playing);

    public void SetVolume(double volume) => scheduler.SetDesiredVolume((float)volume);

    public void SetTransition(TransitionMode mode) => scheduler.SetTransitionMode(mode);

    public void FadeOut() => scheduler.FadeTo(0f);

    public void SetDevice(string requested)
    {
        var position = scheduler.Position;
        var resume = scheduler.Playing;
        var reader = scheduler.Active.Reader;
        if (reader is null)
        {
            deviceId = requested;
            return;
        }
        var wanted = ClientFormatFor(reader);
        OpenClient(requested, wanted);
        deviceId = requested;
        scheduler.ScheduleAt((long)(position * reader.Format.SampleRate), resume);
    }

    public void PrepareNext(string path, string trackId, string? afterTrackId, int? afterBoundarySerial)
    {
        if (afterBoundarySerial is { } serial && serial != scheduler.BoundarySerial)
            throw new AudioCommandException("当前歌曲已接续，已取消过期预备");
        WavReader reader;
        try
        {
            reader = WavReader.Open(path);
        }
        catch (WavException error)
        {
            throw new AudioCommandException(error.Message);
        }
        scheduler.PrepareNext(reader, trackId, afterTrackId);
    }

    public void CancelNext() => scheduler.CancelNext();

    /// <summary>state 命令顺带完成设备断开与引擎停止的检测（对应 Swift 的 state 分支）。</summary>
    public Dictionary<string, object?> State()
    {
        if (deviceId == "default")
        {
            if (boundEndpoint is not null && enumerator is not null &&
                enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia, out var current) == 0 &&
                current.GetId(out var currentId) == 0 && currentId != boundEndpoint)
            {
                SetDevice("default");
            }
        }
        else if (boundEndpoint is not null && !EndpointStillPresent(boundEndpoint))
        {
            scheduler.Pause();
            CloseClient();
            lastError = "所选输出设备已断开，请重新选择";
        }
        else if (scheduler.Playing && !clientRunning)
        {
            scheduler.Pause();
            lastError = "音频输出已停止，设备配置可能已改变，请重新播放";
        }

        var state = new Dictionary<string, object?>
        {
            ["trackId"] = scheduler.TrackId,
            ["playing"] = scheduler.Playing,
            ["currentTime"] = scheduler.Position,
            ["duration"] = scheduler.Duration,
            ["volume"] = Math.Round((double)scheduler.DesiredVolume, 4),
            ["deviceId"] = deviceId,
            ["endedSerial"] = scheduler.EndedSerial,
            ["transitionMode"] = TransitionModes.ToText(scheduler.Mode),
            ["nextTrackId"] = scheduler.NextTrackId,
            ["boundarySerial"] = scheduler.BoundarySerial,
            ["outputSampleRate"] = scheduler.OutputSampleRate,
            // 只增不改：P5 要如实显示当前实际输出格式，这三个字段给出真实协商结果。
            ["outputNegotiated"] = negotiated,
            ["bitPerfect"] = scheduler.BitPerfect,
            ["outputBits"] = clientFormat.BitsPerSample,
            ["outputValidBits"] = clientFormat.ValidBits,
            ["outputIsFloat"] = clientFormat.IsFloat,
            ["shareMode"] = shareMode,
        };
        if (lastError is not null) state["error"] = lastError;

        // 锁屏信息与媒体键面板跟着同一次状态推进；上层每 200 ms 轮询一次 state，
        // 因此时间轴也自然保持更新，不需要额外的定时器。
        if (Smtc is { } smtc)
        {
            var hasTrack = !string.IsNullOrEmpty(scheduler.TrackId);
            smtc.SetTrack(hasTrack ? metadata.Title : null, hasTrack ? metadata.Artist : null, hasTrack ? metadata.Album : null);
            smtc.SetPlayback(scheduler.Playing);
            smtc.SetTimeline(scheduler.Position, scheduler.Duration);
        }
        return state;
    }

    // ---- IMMNotificationClient：热插拔只做标记，实际处理在 state 命令里完成 ----
    public int OnDeviceStateChanged(string deviceId, int newState) { deviceListDirty = true; return 0; }
    public int OnDeviceAdded(string deviceId) { deviceListDirty = true; return 0; }
    public int OnDeviceRemoved(string deviceId) { deviceListDirty = true; return 0; }
    public int OnDefaultDeviceChanged(int flow, int role, string defaultDeviceId) { deviceListDirty = true; return 0; }
    public int OnPropertyValueChanged(string deviceId, PROPERTYKEY key) { deviceListDirty = true; return 0; }
}
