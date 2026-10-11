// 只读 FFmpeg 产出的 PCM WAV。原生服务不含任何解码器。
// FFmpeg 用 -rf64 never，所以不会出现 RF64 大文件格式。
using System.Buffers.Binary;
using Microsoft.Win32.SafeHandles;

namespace RhineWinService;

public sealed class WavFormat
{
    public ushort FormatTag { get; init; }
    public ushort Channels { get; init; }
    public int SampleRate { get; init; }
    /// <summary>容器位深：16 / 24 / 32。</summary>
    public ushort BitsPerSample { get; init; }
    public ushort ValidBits { get; init; }
    public bool IsFloat { get; init; }

    public int BytesPerSample => BitsPerSample / 8;
    public int BlockAlign => Channels * BytesPerSample;
    public bool IsExtensible => FormatTag == WAVEFORMATEX.WAVE_FORMAT_EXTENSIBLE;

    public WavFormat WithNothing() => this;

    public override string ToString() =>
        $"{SampleRate} Hz / {BitsPerSample} bit / {Channels} ch / {(IsFloat ? "float" : "int")}";
}

public sealed class WavReader : IDisposable
{
    private readonly SafeFileHandle handle;
    private readonly long dataOffset;

    public WavFormat Format { get; }
    public long FrameCount { get; }
    public long DataBytes { get; }
    public string Path { get; }
    public double Duration => (double)FrameCount / Format.SampleRate;

    private WavReader(string path, SafeFileHandle handle, WavFormat format, long dataOffset, long dataBytes, long frameCount)
    {
        Path = path;
        this.handle = handle;
        this.dataOffset = dataOffset;
        Format = format;
        DataBytes = dataBytes;
        FrameCount = frameCount;
    }

    public static WavReader Open(string path)
    {
        var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileOptions.RandomAccess);
        try
        {
            Span<byte> header = stackalloc byte[12];
            if (Read(handle, header, 0) != header.Length)
                throw new WavException("音频缓存不是有效的 WAV 文件");
            if (!header[..4].SequenceEqual("RIFF"u8) || !header[8..12].SequenceEqual("WAVE"u8))
                throw new WavException("音频缓存不是 RIFF/WAVE 文件");

            WavFormat? format = null;
            long offset = 12;
            var fileLength = RandomAccess.GetLength(handle);
            Span<byte> chunkHeader = stackalloc byte[8];
            while (offset + 8 <= fileLength)
            {
                if (Read(handle, chunkHeader, offset) != 8) break;
                var id = chunkHeader[..4];
                var size = BinaryPrimitives.ReadUInt32LittleEndian(chunkHeader[4..8]);
                var body = offset + 8;
                if (id.SequenceEqual("fmt "u8))
                {
                    if (size < 16) throw new WavException("WAV 格式块过短");
                    var raw = new byte[Math.Min(size, 40)];
                    if (Read(handle, raw, body) < 16) throw new WavException("WAV 格式块不完整");
                    format = ParseFormat(raw);
                }
                else if (id.SequenceEqual("data"u8))
                {
                    if (format is null) throw new WavException("WAV 数据块出现在格式块之前");
                    var available = Math.Min(size, (ulong)Math.Max(0, fileLength - body));
                    var frames = (long)available / format.BlockAlign;
                    if (frames <= 0) throw new WavException("音频缓存没有可播放的采样");
                    return new WavReader(path, handle, format, body, (long)available, frames);
                }
                offset = body + size + (size % 2);
            }
            throw new WavException("WAV 中找不到音频数据块");
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static WavFormat ParseFormat(ReadOnlySpan<byte> raw)
    {
        var tag = BinaryPrimitives.ReadUInt16LittleEndian(raw);
        var channels = BinaryPrimitives.ReadUInt16LittleEndian(raw[2..]);
        var sampleRate = BinaryPrimitives.ReadInt32LittleEndian(raw[4..]);
        var bits = BinaryPrimitives.ReadUInt16LittleEndian(raw[14..]);
        var valid = bits;
        var isFloat = tag == WAVEFORMATEX.WAVE_FORMAT_IEEE_FLOAT;
        if (tag == WAVEFORMATEX.WAVE_FORMAT_EXTENSIBLE)
        {
            if (raw.Length < 40) throw new WavException("WAVE_FORMAT_EXTENSIBLE 格式块不完整");
            valid = BinaryPrimitives.ReadUInt16LittleEndian(raw[18..]);
            var subFormat = new Guid(raw.Slice(24, 16));
            if (subFormat == AudioSubType.Pcm) isFloat = false;
            else if (subFormat == AudioSubType.IeeeFloat) isFloat = true;
            else throw new WavException($"不支持的 WAV 子格式 {subFormat}");
        }
        else if (tag is not (WAVEFORMATEX.WAVE_FORMAT_PCM or WAVEFORMATEX.WAVE_FORMAT_IEEE_FLOAT))
        {
            throw new WavException($"不支持的 WAV 编码 0x{tag:X4}");
        }

        if (channels is 0 or > 64) throw new WavException("WAV 声道数无效");
        if (sampleRate is < 8000 or > 768000) throw new WavException("WAV 采样率无效");
        if (bits is not (16 or 24 or 32)) throw new WavException($"不支持的 WAV 位深 {bits}");
        if (valid is 0 || valid > bits) valid = bits;
        return new WavFormat
        {
            FormatTag = tag,
            Channels = channels,
            SampleRate = sampleRate,
            BitsPerSample = bits,
            ValidBits = valid,
            IsFloat = isFloat,
        };
    }

    private static int Read(SafeFileHandle handle, Span<byte> buffer, long offset)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = RandomAccess.Read(handle, buffer[total..], offset + total);
            if (read <= 0) break;
            total += read;
        }
        return total;
    }

    /// <summary>把从 frameIndex 开始的 frameCount 帧原始字节读进 destination。</summary>
    public int ReadFrames(long frameIndex, Span<byte> destination, int frameCount)
    {
        if (frameIndex >= FrameCount || frameCount <= 0) return 0;
        var offset = dataOffset + frameIndex * Format.BlockAlign;
        var wanted = (int)Math.Min(frameCount, FrameCount - frameIndex) * Format.BlockAlign;
        var slice = destination[..Math.Min(destination.Length, wanted)];
        return Read(handle, slice, offset);
    }

    public void Dispose() => handle.Dispose();
}

public sealed class WavException : Exception
{
    public WavException(string message) : base(message) { }
}

/// <summary>同采样率、同声道布局下的样本格式转换。</summary>
public static class Pcm
{
    public static void ToFloat(ReadOnlySpan<byte> source, WavFormat format, Span<float> destination)
    {
        var width = format.BytesPerSample;
        var count = destination.Length;
        switch (width)
        {
            case 2:
                for (var i = 0; i < count; i++)
                    destination[i] = BinaryPrimitives.ReadInt16LittleEndian(source[(i * 2)..]) / 32768f;
                break;
            case 3:
                for (var i = 0; i < count; i++)
                {
                    var at = i * 3;
                    var value = source[at] | (source[at + 1] << 8) | ((sbyte)source[at + 2] << 16);
                    destination[i] = value / 8388608f;
                }
                break;
            case 4:
                if (format.IsFloat)
                {
                    for (var i = 0; i < count; i++)
                        destination[i] = BinaryPrimitives.ReadSingleLittleEndian(source[(i * 4)..]);
                }
                else
                {
                    for (var i = 0; i < count; i++)
                        destination[i] = BinaryPrimitives.ReadInt32LittleEndian(source[(i * 4)..]) / 2147483648f;
                }
                break;
            default:
                throw new WavException($"不支持的样本宽度 {width}");
        }
    }

    public static void FromFloat(ReadOnlySpan<float> source, WavFormat format, Span<byte> destination)
    {
        var width = format.BytesPerSample;
        switch (width)
        {
            case 2:
                for (var i = 0; i < source.Length; i++)
                    BinaryPrimitives.WriteInt16LittleEndian(destination[(i * 2)..], (short)Math.Clamp(MathF.Round(source[i] * 32767f), -32768f, 32767f));
                break;
            case 3:
                for (var i = 0; i < source.Length; i++)
                {
                    var value = (int)Math.Clamp(MathF.Round(source[i] * 8388607f), -8388608f, 8388607f);
                    var at = i * 3;
                    destination[at] = (byte)value;
                    destination[at + 1] = (byte)(value >> 8);
                    destination[at + 2] = (byte)(value >> 16);
                }
                break;
            case 4:
                if (format.IsFloat)
                {
                    for (var i = 0; i < source.Length; i++)
                        BinaryPrimitives.WriteSingleLittleEndian(destination[(i * 4)..], source[i]);
                }
                else
                {
                    for (var i = 0; i < source.Length; i++)
                        BinaryPrimitives.WriteInt32LittleEndian(destination[(i * 4)..], (int)Math.Clamp(source[i] * 2147483647f, -2147483648f, 2147483647f));
                }
                break;
            default:
                throw new WavException($"不支持的样本宽度 {width}");
        }
    }
}
