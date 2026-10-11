// WASAPI 的 COM 互操作声明。全部方法保留 HRESULT 返回值（PreserveSig），
// 因为共享/独占协商必须按具体错误码分支，不能把它们揉成异常。
using System.Runtime.InteropServices;

namespace RhineWinService;

internal static class ClsCtx
{
    public const int InprocServer = 0x1;
    public const int All = 0x17;
}

internal static class DataFlow
{
    public const int Render = 0;
    public const int Capture = 1;
    public const int All = 2;
}

internal static class DeviceState
{
    public const int Active = 0x1;
}

internal static class ShareMode
{
    public const int Shared = 0;
    public const int Exclusive = 1;
}

internal static class StreamFlags
{
    public const int EventCallback = 0x00040000;
    public const int NoPersist = 0x00080000;
    // 共享模式下让音频引擎自己做格式/采样率转换，等价于 CoreAudio 的透明重采样。
    public const int AutoConvertPcm = unchecked((int)0x80000000);
    public const int SrcDefaultQuality = 0x08000000;
}

internal static class AudioClientError
{
    // 取值来自 audioclient.h（AUDCLNT_E_BASE = 0x88890000，逐项 +1）。
    public const int NotInitialized = unchecked((int)0x88890001);
    public const int AlreadyInitialized = unchecked((int)0x88890002);
    public const int BufferTooLarge = unchecked((int)0x88890006);
    public const int UnsupportedFormat = unchecked((int)0x88890008);
    public const int DeviceInUse = unchecked((int)0x8889000A);
    public const int ExclusiveModeNotAllowed = unchecked((int)0x8889000E);
    public const int EndpointCreateFailed = unchecked((int)0x8889000F);
    public const int ServiceNotRunning = unchecked((int)0x88890010);
    public const int EventHandleNotExpected = unchecked((int)0x88890011);
    public const int BufferSizeError = unchecked((int)0x88890016);
    public const int BufferSizeNotAligned = unchecked((int)0x88890019);
}

internal static class AudioSubType
{
    public static readonly Guid Pcm = new("00000001-0000-0010-8000-00aa00389b71");
    public static readonly Guid IeeeFloat = new("00000003-0000-0010-8000-00aa00389b71");
}

internal static class Role
{
    public const int Console = 0;
    public const int Multimedia = 1;
    public const int Communications = 2;
}

[StructLayout(LayoutKind.Sequential)]
internal struct PROPERTYKEY
{
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Explicit)]
internal struct PropVariant
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;

    public const ushort VT_LPWSTR = 31;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
internal struct WAVEFORMATEX
{
    public ushort wFormatTag;
    public ushort nChannels;
    public int nSamplesPerSec;
    public int nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;

    public const ushort WAVE_FORMAT_PCM = 1;
    public const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
    public const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
internal struct WAVEFORMATEXTENSIBLE
{
    public WAVEFORMATEX Format;
    public ushort wValidBitsPerSample;
    public uint dwChannelMask;
    public Guid SubFormat;
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumeratorComObject
{
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IMMNotificationClient client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IMMNotificationClient client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceCollection
{
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PropVariant value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PropVariant value);
    [PreserveSig] int Commit();
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint bufferFrames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
    [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr eventHandle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioRenderClient
{
    [PreserveSig] int GetBuffer(uint framesRequested, out IntPtr data);
    [PreserveSig] int ReleaseBuffer(uint framesWritten, int flags);
}

/// <summary>设备热插拔回调。托管实现，因此不加 ComImport。</summary>
[Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMNotificationClient
{
    [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int newState);
    [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
    [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
    [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string defaultDeviceId);
    [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, PROPERTYKEY key);
}

internal static class WasapiNative
{
    public static readonly Guid IidAudioClient = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    public static readonly Guid IidAudioRenderClient = new("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");
    public static readonly PROPERTYKEY PkeyDeviceFriendlyName = new()
    {
        fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
        pid = 14,
    };

    [DllImport("ole32.dll")]
    public static extern void PropVariantClear(ref PropVariant value);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetEvent(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    public const uint WaitObject0 = 0;
    public const uint WaitTimeout = 258;

    public static string Describe(int hr) => $"0x{hr:X8}";
}
