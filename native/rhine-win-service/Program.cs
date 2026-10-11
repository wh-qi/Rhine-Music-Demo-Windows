// RhineWinService：stdin 逐行读 JSON、stdout 逐行写 JSON 的原生音频服务。
// 协议与语义以 native/RhineAudio.swift 为准，逐条对齐。
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace RhineWinService;

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static int Main(string[] args)
    {
        if (args.Contains("--selftest")) return SelfTest.Run();
        if (args.Contains("--smtc-read")) return Smtc.DumpCurrentSessionAsync().GetAwaiter().GetResult();
        // 直接包装标准流，避免重定向时设置 Console 编码抛异常。
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        using var stream = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        var writer = new ProtocolWriter(stream);
        var service = new WasapiOutput();
        // SMTC 的回调在专属 STA 线程上触发，必须和响应写出共用同一把锁，否则会撕裂 JSON 行。
        using var smtc = new Smtc((button) => writer.Send($"{{\"event\":\"media\",\"button\":{JsonSerializer.Serialize(button, Json)}}}"));
        service.Smtc = smtc;
        try
        {
            string? line;
            while ((line = input.ReadLine()) is not null)
            {
                if (line.Length == 0) continue;
                JsonDocument document;
                try { document = JsonDocument.Parse(line); }
                catch { continue; }
                using (document)
                {
                    var root = document.RootElement;
                    var id = root.TryGetProperty("id", out var idElement) ? idElement.GetRawText() : "0";
                    try
                    {
                        var result = Execute(service, root);
                        writer.Send($"{{\"id\":{id},\"result\":{JsonSerializer.Serialize(result, Json)}}}");
                    }
                    catch (Exception error)
                    {
                        writer.Send($"{{\"id\":{id},\"error\":{JsonSerializer.Serialize(error.Message, Json)}}}");
                    }
                }
            }
        }
        finally
        {
            service.Dispose();
        }
        return 0;
    }

    private static object Execute(WasapiOutput service, JsonElement root)
    {
        var action = root.TryGetProperty("action", out var actionElement) && actionElement.ValueKind == JsonValueKind.String
            ? actionElement.GetString() ?? "state"
            : "state";
        service.ClearError();

        // 与 Swift 一致：衔接方式先于动作处理，且 transition 只做设置。
        if (root.TryGetProperty("transitionMode", out var modeElement))
        {
            if (modeElement.ValueKind != JsonValueKind.String || !TransitionModes.TryParse(modeElement.GetString(), out var mode))
                throw new AudioCommandException("无效歌曲衔接方式");
            service.SetTransition(mode);
        }
        else if (root.TryGetProperty("fadeEnabled", out var fadeElement))
        {
            if (fadeElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new AudioCommandException("无效淡入淡出设置");
            service.SetTransition(fadeElement.GetBoolean() ? TransitionMode.FadeInOut : TransitionMode.Gapless);
        }

        switch (action)
        {
            case "devices":
                return new Dictionary<string, object?>
                {
                    ["devices"] = service.Devices()
                        .Select(item => new Dictionary<string, object?> { ["id"] = item.Id, ["name"] = item.Name })
                        .ToList(),
                };

            case "state":
                return service.State();

            case "play":
            {
                var path = Text(root, "path");
                if (path is null)
                {
                    service.Resume();
                    return service.State();
                }
                var trackId = Text(root, "trackId") ?? "";
                var position = Number(root, "position") ?? 0;
                var device = Text(root, "deviceId") ?? "default";
                // metadata 是可选的：锁屏与媒体面板要显示曲目信息，但不影响任何播放语义。
                (string, string, string)? info = null;
                if (root.TryGetProperty("metadata", out var meta) && meta.ValueKind == JsonValueKind.Object)
                    info = (Text(meta, "title") ?? "", Text(meta, "artist") ?? "", Text(meta, "album") ?? "");
                service.Play(path, trackId, position, device, Number(root, "volume"), info);
                return service.State();
            }

            case "pause":
                service.Pause();
                return service.State();

            case "seek":
                service.Seek(Number(root, "position") ?? 0);
                return service.State();

            case "stop":
                service.Stop();
                return service.State();

            case "volume":
                service.SetVolume(Number(root, "volume") ?? 0.7);
                return service.State();

            case "device":
                service.SetDevice(Text(root, "deviceId") ?? "default");
                return service.State();

            case "transition":
                if (!root.TryGetProperty("transitionMode", out _) && !root.TryGetProperty("fadeEnabled", out _))
                    throw new AudioCommandException("缺少歌曲衔接方式");
                return service.State();

            case "prepareNext":
            {
                var path = Text(root, "path");
                var trackId = Text(root, "trackId");
                if (path is null || trackId is null) throw new AudioCommandException("缺少下一首音频");
                var serial = root.TryGetProperty("afterBoundarySerial", out var serialElement) && serialElement.ValueKind == JsonValueKind.Number
                    ? serialElement.GetInt32()
                    : (int?)null;
                service.PrepareNext(path, trackId, Text(root, "afterTrackId"), serial);
                return service.State();
            }

            case "cancelNext":
                service.CancelNext();
                return service.State();

            case "fadeOut":
                service.FadeOut();
                return service.State();

            case "bitPerfect":
                service.BitPerfect = root.TryGetProperty("enabled", out var enabled) && enabled.ValueKind == JsonValueKind.True;
                return service.State();

            default:
                throw new AudioCommandException("未知音频指令");
        }
    }

    /// <summary>诊断输出一律 UTF-8，避免中文在控制台代码页下变成乱码。</summary>
    internal static class Diagnostics
    {
        private static readonly StreamWriter Writer = new(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };

        public static void Line(string text)
        {
            lock (Writer) Writer.WriteLine(text);
        }
    }

    /// <summary>协议行写出：主线程与 SMTC 线程共用。</summary>
    private sealed class ProtocolWriter(StreamWriter writer)
    {
        private readonly object gate = new();

        public void Send(string line)
        {
            lock (gate) writer.WriteLine(line);
        }
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String ? element.GetString() : null;

    private static double? Number(JsonElement root, string name) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number ? element.GetDouble() : null;
}
