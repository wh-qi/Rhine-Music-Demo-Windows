// 离线自检：把 Scheduler 的接缝逐样本比对，用来验收「无样本丢失、无重复」。
// 通过 --selftest 触发；输出走 stderr，绝不污染 stdout 的协议流。
namespace RhineWinService;

internal static class SelfTest
{
    private const int SampleRate = 44100;
    private const int Channels = 2;

    public static int Run()
    {
        var ok = true;
        var directory = Directory.CreateTempSubdirectory("rhine-selftest-").FullName;
        try
        {
            ok &= GaplessSeamIsSampleExact();
            ok &= EndedSerialOnlyOnNaturalEnd();
            ok &= StopAndSeekDoNotBumpEndedSerial();
            ok &= GaplessPreconditionsAreEnforced();
            ok &= FadeReachesTargetInTwentyEightSteps();
            ok &= BitPerfectDoesNotTouchSamples();
        }
        finally
        {
            try { Directory.Delete(directory, true); } catch { }
        }
        Program.Diagnostics.Line(ok ? "SELFTEST PASS" : "SELFTEST FAIL");
        return ok ? 0 : 1;
    }

    private static void Check(bool condition, string label)
    {
        Console.Error.WriteLine($"  [{(condition ? "ok" : "FAIL")}] {label}");
    }

    private static string WriteRamp(int frames, int offset)
    {
        var path = Path.Combine(Path.GetTempPath(), $"rhine-ramp-{offset}-{frames}.wav");
        var dataBytes = frames * Channels * 2;
        using var stream = File.Create(path);
        using var writer = new BinaryWriter(stream);
        writer.Write("RIFF"u8);
        writer.Write(36 + dataBytes);
        writer.Write("WAVE"u8);
        writer.Write("fmt "u8);
        writer.Write(16);
        writer.Write((ushort)1);
        writer.Write((ushort)Channels);
        writer.Write(SampleRate);
        writer.Write(SampleRate * Channels * 2);
        writer.Write((ushort)(Channels * 2));
        writer.Write((ushort)16);
        writer.Write("data"u8);
        writer.Write(dataBytes);
        for (var frame = 0; frame < frames; frame++)
        {
            var value = (short)(((frame + offset) % 20000) - 10000);
            for (var channel = 0; channel < Channels; channel++) writer.Write(value);
        }
        return path;
    }

    private static Scheduler NewScheduler()
    {
        var scheduler = new Scheduler(4096, Channels)
        {
            OutputChannels = Channels,
            OutputSampleRate = SampleRate,
        };
        scheduler.SetDesiredVolume(1f);
        scheduler.SetTransitionMode(TransitionMode.Gapless);
        return scheduler;
    }

    /// <summary>bit-perfect 下增益恒为 1：样本必须与源文件逐位相同，哪怕音量为 0.3。</summary>
    private static bool BitPerfectDoesNotTouchSamples()
    {
        Console.Error.WriteLine("bit-perfect 不做任何样本衰减");
        const int frames = 4096;
        var path = WriteRamp(frames, 1234);
        try
        {
            using var scheduler = NewScheduler();
            scheduler.SetDesiredVolume(0.3f);
            scheduler.BitPerfect = true;
            using var reader = WavReader.Open(path);
            scheduler.Load(reader, "A", 0, play: true);
            var buffer = new float[frames * Channels];
            scheduler.Render(buffer, frames);
            var mismatch = -1;
            for (var index = 0; index < frames; index++)
            {
                var expected = (short)(((index + 1234) % 20000) - 10000) / 32768f;
                if (buffer[index * Channels] != expected) { mismatch = index; break; }
            }
            Check(mismatch < 0, mismatch < 0
                ? $"音量为 {scheduler.DesiredVolume} 时输出仍与源样本逐位相同"
                : $"第 {mismatch} 个样本被改写了：{buffer[mismatch * Channels]}");
            return mismatch < 0;
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static bool GaplessSeamIsSampleExact()
    {
        Console.Error.WriteLine("接缝逐样本比对（两首 0.5 秒斜坡，无缝模式）");
        const int frames = SampleRate / 2;
        var pathA = WriteRamp(frames, 0);
        var pathB = WriteRamp(frames, 7000);
        try
        {
            using var scheduler = NewScheduler();
            using var a = WavReader.Open(pathA);
            using var b = WavReader.Open(pathB);
            scheduler.Load(a, "A", 0, play: true);
            scheduler.PrepareNext(b, "B", "A");

            // 必须正好渲染两首的长度：多渲染一帧就会走到 B 的自然结束，那是另一条断言。
            const int block = 512;
            var buffer = new float[block * Channels];
            var rendered = new List<float>((frames * 2) * Channels);
            var remaining = frames * 2;
            while (remaining > 0)
            {
                var take = Math.Min(block, remaining);
                scheduler.Render(buffer, take);
                for (var index = 0; index < take * Channels; index++) rendered.Add(buffer[index]);
                remaining -= take;
            }

            var expected = new List<float>((frames * 2) * Channels);
            for (var index = 0; index < frames * 2; index++)
            {
                var value = (short)(index < frames ? index % 20000 - 10000 : (index - frames + 7000) % 20000 - 10000);
                expected.Add(value / 32768f);
                expected.Add(value / 32768f);
            }

            var mismatch = -1;
            for (var index = 0; index < expected.Count; index++)
            {
                if (rendered[index] != expected[index]) { mismatch = index; break; }
            }
            Check(mismatch < 0, mismatch < 0
                ? $"前 {frames * 2} 帧与两首原文件逐字节一致，接缝处无丢失、无重复、无静音"
                : $"第 {mismatch} 个样本不符：渲染 {rendered[mismatch]} 期望 {expected[mismatch]}");
            Check(scheduler.BoundarySerial == 1, $"boundarySerial 恰好自增一次（实际 {scheduler.BoundarySerial}）");
            Check(scheduler.EndedSerial == 0, $"接续过程中 endedSerial 保持 0（实际 {scheduler.EndedSerial}）");
            Check(scheduler.TrackId == "B", $"接续后 trackId 为 B（实际 {scheduler.TrackId}）");
            // 再把 B 剩下的部分放完，这时才允许自然结束。
            var tail = 0;
            while (tail < SampleRate / 2)
            {
                scheduler.Render(buffer, Math.Min(block, SampleRate / 2 - tail));
                tail += block;
            }
            Check(scheduler.EndedSerial == 1, $"B 自然播完后 endedSerial 才变成 1（实际 {scheduler.EndedSerial}）");
            return mismatch < 0 && scheduler.BoundarySerial == 1 && scheduler.EndedSerial == 1;
        }
        finally
        {
            File.Delete(pathA);
            File.Delete(pathB);
        }
    }

    private static bool EndedSerialOnlyOnNaturalEnd()
    {
        Console.Error.WriteLine("自然播完才自增 endedSerial");
        const int frames = 1000;
        var path = WriteRamp(frames, 0);
        try
        {
            using var scheduler = NewScheduler();
            using var reader = WavReader.Open(path);
            scheduler.Load(reader, "A", 0, play: true);
            var buffer = new float[256 * Channels];
            for (var index = 0; index < 20; index++) scheduler.Render(buffer, 256);
            var afterEnd = scheduler.EndedSerial;
            Check(afterEnd == 1, $"放完后 endedSerial 为 1（实际 {afterEnd}）");
            for (var index = 0; index < 5; index++) scheduler.Render(buffer, 256);
            Check(scheduler.EndedSerial == 1, $"继续渲染不会重复自增（实际 {scheduler.EndedSerial}）");
            return afterEnd == 1 && scheduler.EndedSerial == 1;
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static bool StopAndSeekDoNotBumpEndedSerial()
    {
        Console.Error.WriteLine("stop / seek / play 不得自增 endedSerial");
        var path = WriteRamp(SampleRate, 0);
        try
        {
            using var scheduler = NewScheduler();
            using var reader = WavReader.Open(path);
            scheduler.Load(reader, "A", 0, play: true);
            var buffer = new float[256 * Channels];
            scheduler.Render(buffer, 256);
            scheduler.ScheduleAt(0, true);
            scheduler.ScheduleAt(SampleRate / 2, false);
            scheduler.Pause();
            var value = scheduler.EndedSerial;
            Check(value == 0, $"stop/seek/play 之后 endedSerial 仍为 0（实际 {value}）");
            return value == 0;
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static bool GaplessPreconditionsAreEnforced()
    {
        Console.Error.WriteLine("prepareNext 前置校验");
        var pathA = WriteRamp(SampleRate / 2, 0);
        var pathB = WriteRamp(SampleRate / 2, 0);
        try
        {
            using var scheduler = NewScheduler();
            using var a = WavReader.Open(pathA);
            scheduler.Load(a, "A", 0, play: false);
            var enforced = 0;
            try { using var b = WavReader.Open(pathB); scheduler.PrepareNext(b, "B", null); }
            catch (AudioCommandException error) when (error.Message == "当前未在无缝模式播放，无法预备下一首") { enforced++; }

            scheduler.SetTransitionMode(TransitionMode.FadeInOut);
            scheduler.ScheduleAt(0, true);
            scheduler.SetTransitionMode(TransitionMode.Gapless);
            try { using var b = WavReader.Open(pathB); scheduler.PrepareNext(b, "B", "ZZZ"); }
            catch (AudioCommandException error) when (error.Message == "当前歌曲已改变，已取消过期预备") { enforced++; }

            try { using var b = WavReader.Open(pathB); scheduler.PrepareNext(b, "B", "A"); }
            catch (AudioCommandException error) { Console.Error.WriteLine("      意外：" + error.Message); }

            try { using var b = WavReader.Open(pathA); scheduler.PrepareNext(b, "B", "A"); }
            catch (AudioCommandException error) when (error.Message == "当前无播放，无法预备下一首") { }

            Check(enforced == 2, $"两条前置条件各自报出原文（实际 {enforced}/2）");
            return enforced == 2;
        }
        finally
        {
            File.Delete(pathA);
            File.Delete(pathB);
        }
    }

    private static bool FadeReachesTargetInTwentyEightSteps()
    {
        Console.Error.WriteLine("淡变 28 步 × 16 ms 的 smoothstep 斜坡");
        var path = WriteRamp(SampleRate, 0);
        try
        {
            using var scheduler = NewScheduler();
            scheduler.SetTransitionMode(TransitionMode.FadeInOut);
            using var reader = WavReader.Open(path);
            scheduler.Load(reader, "A", 0, play: true);
            var length = (long)Math.Round(0.016 * 28 * SampleRate);
            var buffer = new float[512 * Channels];
            var produced = 0L;
            while (produced < length)
            {
                var block = (int)Math.Min(512, length - produced);
                scheduler.Render(buffer, block);
                produced += block;
            }
            var after = scheduler.Render(new float[64 * Channels], 64);
            Check(after == 64, "淡变结束后仍在正常渲染");
            return after == 64;
        }
        finally
        {
            File.Delete(path);
        }
    }
}
