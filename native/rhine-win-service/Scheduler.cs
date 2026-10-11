// 双槽排程：当前曲与预备曲各占一个槽，渲染线程在样本级边界上切换，
// 因此接缝没有空隙也没有重叠 —— 比两个独立播放节点更精确。
namespace RhineWinService;

public enum TransitionMode
{
    FadeOut,
    FadeInOut,
    Gapless,
}

public static class TransitionModes
{
    public const string FadeOut = "fade-out";
    public const string FadeInOut = "fade-in-out";
    public const string Gapless = "gapless";

    public static bool TryParse(string? text, out TransitionMode mode)
    {
        switch (text)
        {
            case FadeOut: mode = TransitionMode.FadeOut; return true;
            case FadeInOut: mode = TransitionMode.FadeInOut; return true;
            case Gapless: mode = TransitionMode.Gapless; return true;
            default: mode = TransitionMode.FadeInOut; return false;
        }
    }

    public static string ToText(TransitionMode mode) => mode switch
    {
        TransitionMode.FadeOut => FadeOut,
        TransitionMode.Gapless => Gapless,
        _ => FadeInOut,
    };
}

public sealed class SchedulerSlot
{
    public WavReader? Reader;
    public long FrameIndex;
    public string TrackId = "";

    public bool HasAudio => Reader is not null;
    public bool Exhausted => Reader is not null && FrameIndex >= Reader.FrameCount;
}

public sealed class Scheduler : IDisposable
{
    private readonly SchedulerSlot[] slots = [new(), new()];
    private readonly byte[] rawBuffer;
    private int activeSlot;

    public Scheduler(int maxBlockFrames, int maxChannels)
    {
        rawBuffer = new byte[maxBlockFrames * maxChannels * 4];
    }

    public int OutputChannels { get; set; } = 2;
    public int OutputSampleRate { get; set; } = 44100;
    public bool BitPerfect { get; set; }

    public int ActiveSlot => activeSlot;
    public int BoundarySerial { get; private set; }
    public int EndedSerial { get; internal set; }
    public bool Playing { get; set; }
    public float DesiredVolume { get; private set; } = 0.7f;
    public TransitionMode Mode { get; private set; } = TransitionMode.FadeInOut;

    /// <summary>已渲染的输出帧数，淡变与位置都以它为准。</summary>
    public long RenderedFrames { get; private set; }

    private float volume = 1f;
    private float fadeFrom;
    private float fadeTo;
    private long fadeStart = -1;
    private long fadeLength;
    private bool fadingIn;

    public SchedulerSlot Active => slots[activeSlot];
    public SchedulerSlot Standby => slots[1 - activeSlot];
    public SchedulerSlot SlotAt(int index) => slots[index];

    public string TrackId => slots[activeSlot].TrackId;
    public string NextTrackId => slots[1 - activeSlot].HasAudio ? slots[1 - activeSlot].TrackId : "";
    public double Duration => slots[activeSlot].Reader?.Duration ?? 0;
    public long FrameCount => slots[activeSlot].Reader?.FrameCount ?? 0;
    public long FrameIndex => slots[activeSlot].FrameIndex;

    public double Position
    {
        get
        {
            var reader = slots[activeSlot].Reader;
            if (reader is null) return 0;
            return Math.Min(reader.Duration, (double)slots[activeSlot].FrameIndex / reader.Format.SampleRate);
        }
    }

    public void SetDesiredVolume(float value)
    {
        DesiredVolume = Math.Clamp(value, 0f, 1f);
        CancelFade();
        volume = DesiredVolume;
    }

    public bool SetTransitionMode(TransitionMode mode)
    {
        var changed = mode != Mode;
        if (changed) CancelNext();
        Mode = mode;
        if (mode != TransitionMode.FadeInOut && fadingIn)
        {
            CancelFade();
            volume = DesiredVolume;
        }
        return changed;
    }

    public void FadeTo(float target)
    {
        fadeFrom = volume;
        fadeTo = target;
        fadeStart = RenderedFrames;
        fadeLength = (long)Math.Round(0.016 * 28 * OutputSampleRate);
        fadingIn = target > volume;
        if (fadeLength <= 0)
        {
            volume = target;
            fadeStart = -1;
            fadingIn = false;
        }
    }

    public void CancelFade()
    {
        fadeStart = -1;
        fadingIn = false;
    }

    private float VolumeAt(long rendered)
    {
        if (fadeStart < 0) return volume;
        var elapsed = rendered - fadeStart;
        if (elapsed >= fadeLength)
        {
            volume = fadeTo;
            fadeStart = -1;
            fadingIn = false;
            return volume;
        }
        if (elapsed <= 0) return fadeFrom;
        var p = (float)elapsed / fadeLength;
        return fadeFrom + (fadeTo - fadeFrom) * (p * p * (3 - 2 * p));
    }

    /// <summary>把当前槽替换成一个新文件，并从头（或指定位置）开始排程。</summary>
    public void Load(WavReader reader, string trackId, double offsetSeconds, bool play)
    {
        CancelNext();
        CancelFade();
        var old = slots[activeSlot].Reader;
        slots[activeSlot].Reader = reader;
        slots[activeSlot].TrackId = trackId;
        old?.Dispose();
        var startFrame = (long)Math.Clamp(offsetSeconds * reader.Format.SampleRate, 0, reader.FrameCount);
        ScheduleAt(startFrame, play);
    }

    /// <summary>seek / play 共用的排程：从指定帧开始，保持或改变播放状态。</summary>
    public void ScheduleAt(long startFrame, bool play)
    {
        var reader = slots[activeSlot].Reader;
        if (reader is null) return;
        CancelNext();
        CancelFade();
        slots[activeSlot].FrameIndex = Math.Clamp(startFrame, 0, reader.FrameCount);
        RenderedFrames = 0;
        if (slots[activeSlot].FrameIndex >= reader.FrameCount)
        {
            // Swift 的行为：已经把这一首放完时再按播放，记为一次自然结束。
            if (play) EndedSerial++;
            Playing = false;
            return;
        }
        if (play)
        {
            volume = Mode == TransitionMode.FadeInOut ? 0f : DesiredVolume;
            Playing = true;
            if (Mode == TransitionMode.FadeInOut) FadeTo(DesiredVolume);
        }
        else
        {
            Playing = false;
        }
    }

    public void Pause()
    {
        CancelNext();
        CancelFade();
        Playing = false;
    }

    public void Stop()
    {
        CancelNext();
        CancelFade();
        Playing = false;
        var reader = slots[activeSlot].Reader;
        slots[activeSlot].Reader = null;
        slots[activeSlot].TrackId = "";
        slots[activeSlot].FrameIndex = 0;
        reader?.Dispose();
        RenderedFrames = 0;
    }

    public void Clear()
    {
        for (var index = 0; index < slots.Length; index++)
        {
            slots[index].Reader?.Dispose();
            slots[index].Reader = null;
            slots[index].TrackId = "";
            slots[index].FrameIndex = 0;
        }
    }

    /// <summary>预备下一首。全部前置校验按规范 5.3 逐条执行。</summary>
    public void PrepareNext(WavReader reader, string trackId, string? afterTrackId)
    {
        if (Mode != TransitionMode.Gapless || !Playing || slots[activeSlot].Reader is null)
            throw new AudioCommandException("当前未在无缝模式播放，无法预备下一首");
        if (afterTrackId is not null && afterTrackId != slots[activeSlot].TrackId)
            throw new AudioCommandException("当前歌曲已改变，已取消过期预备");
        if (slots[1 - activeSlot].HasAudio && slots[1 - activeSlot].TrackId == trackId)
        {
            reader.Dispose();
            return;
        }
        CancelNext();
        var outputChannels = OutputChannels;
        if (reader.Format.Channels > outputChannels)
            throw new AudioCommandException("下一首声道数增加，需要重新配置输出；本次无法无缝接续");
        if (reader.Format.SampleRate != OutputSampleRate)
            throw new AudioCommandException("下一首尚未转换到当前输出采样率，无法准确无缝接续");
        // 规范 5.3 第 5 条：必须在当前曲目结束前至少 20 ms 完成排程。
        var remaining = slots[activeSlot].Reader!.FrameCount - slots[activeSlot].FrameIndex;
        if (remaining < OutputSampleRate / 50)
        {
            reader.Dispose();
            throw new AudioCommandException("下一首未能在当前歌曲结束前准备完成");
        }
        var slot = slots[1 - activeSlot];
        slot.Reader = reader;
        slot.TrackId = trackId;
        slot.FrameIndex = 0;
    }

    public void CancelNext()
    {
        var slot = slots[1 - activeSlot];
        if (!slot.HasAudio) return;
        slot.Reader?.Dispose();
        slot.Reader = null;
        slot.TrackId = "";
        slot.FrameIndex = 0;
    }

    private void PromoteNext()
    {
        var prepared = slots[1 - activeSlot];
        // 旧槽必须彻底清空：否则 nextTrackId 会继续报出已经放完的那一首。
        var finished = slots[activeSlot];
        finished.Reader?.Dispose();
        finished.Reader = null;
        finished.TrackId = "";
        finished.FrameIndex = 0;
        activeSlot = 1 - activeSlot;
        prepared.FrameIndex = 0;
        RenderedFrames = 0;
        BoundarySerial++;
        volume = DesiredVolume;
        CancelFade();
    }

    /// <summary>
    /// 渲染 frames 帧到 destination（交错 float，长度 frames*OutputChannels）。
    /// 返回真正来自音频的帧数；其余部分已经是静音。
    /// </summary>
    public int Render(Span<float> destination, int frames)
    {
        var channels = OutputChannels;
        destination[..(frames * channels)].Clear();
        // 暂停/停止时不推进文件指针，渲染线程只输出静音。
        if (!Playing) return 0;
        var written = 0;
        while (written < frames)
        {
            var slot = slots[activeSlot];
            var reader = slot.Reader;
            if (reader is null || slot.Exhausted)
            {
                if (!slot.Exhausted && reader is null) break;
                var standby = slots[1 - activeSlot];
                if (standby.HasAudio && !standby.Exhausted)
                {
                    PromoteNext();
                    continue;
                }
                if (Playing)
                {
                    EndedSerial++;
                    Playing = false;
                }
                break;
            }

            var take = (int)Math.Min(reader.FrameCount - slot.FrameIndex, frames - written);
            var byteCount = take * reader.Format.BlockAlign;
            if (byteCount > rawBuffer.Length) throw new WavException("渲染块超过内部缓冲");
            var raw = rawBuffer.AsSpan(0, byteCount);
            var got = reader.ReadFrames(slot.FrameIndex, raw, take);
            if (got < reader.Format.BlockAlign)
            {
                // 读取失败或文件被截断，按自然结束处理。
                slot.FrameIndex = reader.FrameCount;
                continue;
            }
            take = got / reader.Format.BlockAlign;
            var samples = take * reader.Format.Channels;
            var gain = BitPerfect ? 1f : VolumeAt(RenderedFrames);
            WriteSamples(raw, reader.Format, destination.Slice(written * channels, take * channels), samples, gain, channels);
            slot.FrameIndex += take;
            written += take;
            RenderedFrames += take;
        }
        if (written < frames)
            destination.Slice(written * channels, (frames - written) * channels).Clear();
        return written;
    }

    private void WriteSamples(ReadOnlySpan<byte> raw, WavFormat format, Span<float> target, int samples, float gain, int targetChannels)
    {
        var sourceChannels = format.Channels;
        for (var i = 0; i < samples; i++)
        {
            var value = ReadSample(raw, format, i) * gain;
            if (sourceChannels == 1)
            {
                for (var channel = 0; channel < targetChannels; channel++) target[i * targetChannels + channel] = value;
            }
            else
            {
                var channel = i % sourceChannels;
                if (channel < targetChannels) target[(i / sourceChannels) * targetChannels + channel] = value;
            }
        }
    }

    private static float ReadSample(ReadOnlySpan<byte> raw, WavFormat format, int index)
    {
        switch (format.BytesPerSample)
        {
            case 2:
                return (short)(raw[index * 2] | (raw[index * 2 + 1] << 8)) / 32768f;
            case 3:
                var at = index * 3;
                return (raw[at] | (raw[at + 1] << 8) | ((sbyte)raw[at + 2] << 16)) / 8388608f;
            default:
                if (format.IsFloat) return BitConverter.Int32BitsToSingle(raw[index * 4] | (raw[index * 4 + 1] << 8) | (raw[index * 4 + 2] << 16) | (raw[index * 4 + 3] << 24));
                return (raw[index * 4] | (raw[index * 4 + 1] << 8) | (raw[index * 4 + 2] << 16) | (raw[index * 4 + 3] << 24)) / 2147483648f;
        }
    }

    public void Dispose() => Clear();
}

public sealed class AudioCommandException : Exception
{
    public AudioCommandException(string message) : base(message) { }
}
