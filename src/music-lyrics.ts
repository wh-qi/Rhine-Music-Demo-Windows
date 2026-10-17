/**
 * 歌词面板：按播放时间把当前行高亮并滚动到中间。
 *
 * 数据来自 /api/lyrics/:trackId，已是 [{ ms, text }] 且按时间升序
 * （扫描阶段由 music-library.mjs 归一并以曲目时长裁剪过）。
 */

export interface LyricsLine {
  ms: number;
  text: string;
  /** 同时间戳的第二行视为译词，贴在主语言下面显示。 */
  translation?: string;
}

// 作词/作曲一类的头部信息常与下一行同时间戳，不能当成译词配对。
const CREDIT = /^(作词|作詞|作曲|編曲|编曲|lyric|compos|arrang|mix|master)/i;

/** 把「同一时间戳的两行」合并成 主语言 + 译词。 */
export function groupTranslations(lines: LyricsLine[]): LyricsLine[] {
  const merged: LyricsLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    const paired =
      next &&
      next.ms === line.ms &&
      // 三行以上同时间的多半是头部 credits，不做配对。
      (lines[i + 2]?.ms !== line.ms) &&
      !CREDIT.test(line.text) &&
      !CREDIT.test(next.text);
    if (paired) {
      merged.push({ ms: line.ms, text: line.text, translation: next.text });
      i += 1;
    } else merged.push(line);
  }
  return merged;
}

const formatStamp = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export class LyricsView {
  private lines: LyricsLine[] = [];
  private current = -1;
  private pending: AbortController | null = null;
  private trackId = "";

  constructor(private readonly root: HTMLElement, private readonly list: HTMLElement) {}

  /** 换曲目时清空，避免上一首的歌词闪一下。 */
  reset() {
    this.pending?.abort();
    this.pending = null;
    this.trackId = "";
    this.lines = [];
    this.current = -1;
    this.list.replaceChildren();
    this.root.dataset.lyricsState = "empty";
  }

  async load(trackId: string, title: string, artist: string) {
    if (this.trackId === trackId) return;
    this.reset();
    this.trackId = trackId;
    this.root.dataset.lyricsState = "loading";
    const controller = new AbortController();
    this.pending = controller;
    try {
      const response = await fetch(`/api/lyrics/${encodeURIComponent(trackId)}`, { signal: controller.signal });
      if (!response.ok) throw new Error("没有带时间轴的歌词");
      const body = (await response.json()) as { lines?: LyricsLine[] };
      if (controller.signal.aborted || this.trackId !== trackId) return;
      const lines = Array.isArray(body.lines)
        ? groupTranslations(body.lines.filter((line) => Number.isFinite(line?.ms) && typeof line.text === "string" && line.text)
          .sort((a, b) => a.ms - b.ms))
        : [];
      if (!lines.length) throw new Error("歌词为空");
      this.lines = lines;
      this.render(title, artist);
      this.root.dataset.lyricsState = "ready";
    } catch (error) {
      if (controller.signal.aborted) return;
      this.lines = [];
      this.list.replaceChildren();
      this.root.dataset.lyricsState = "missing";
      this.root.dataset.lyricsMessage = error instanceof Error ? error.message : "歌词不可用";
    } finally {
      if (this.pending === controller) this.pending = null;
    }
  }

  private render(title: string, artist: string) {
    const fragment = document.createDocumentFragment();
    for (const line of this.lines) {
      const item = document.createElement("li");
      item.className = "lyrics-line";
      item.dataset.ms = String(line.ms);
      item.innerHTML = `<span class="lyrics-stamp">${formatStamp(line.ms)}</span><span class="lyrics-text"></span>`;
      (item.querySelector(".lyrics-text") as HTMLElement).textContent = line.text;
      if (line.translation) {
        const sub = document.createElement("span");
        sub.className = "lyrics-translation";
        sub.textContent = line.translation;
        item.append(sub);
      }
      item.title = `${title} · ${artist}`;
      fragment.append(item);
    }
    this.list.replaceChildren(fragment);
    this.current = -1;
  }

  /** 二分找最后一个 ms <= 当前时间的行。 */
  private indexAt(ms: number) {
    let low = 0;
    let high = this.lines.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.lines[middle].ms <= ms) { found = middle; low = middle + 1; }
      else high = middle - 1;
    }
    return found;
  }

  /** 由播放器时间驱动；只在行号变化时才改 DOM。 */
  sync(seconds: number) {
    if (!this.lines.length || !Number.isFinite(seconds)) return;
    const index = this.indexAt(Math.round(seconds * 1000));
    if (index === this.current) return;
    const items = this.list.children;
    this.current = index;
    for (let i = 0; i < items.length; i += 1) {
      (items[i] as HTMLElement).dataset.active = i === index ? "true" : "false";
      (items[i] as HTMLElement).dataset.past = i < index ? "true" : "false";
    }
    const active = items[index] as HTMLElement | undefined;
    if (!active) return;
    // 让当前行停在列表中间；开头几行不强行居中，避免顶部留白。
    const offset = active.offsetTop - this.list.clientHeight / 2 + active.offsetHeight / 2;
    this.list.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
  }

  /** 点击某一行直接跳转，返回该行毫秒数。 */
  lineAt(target: EventTarget | null): number | null {
    const item = (target as HTMLElement | null)?.closest<HTMLElement>(".lyrics-line");
    if (!item) return null;
    const ms = Number(item.dataset.ms);
    return Number.isFinite(ms) ? ms : null;
  }

  get size() { return this.lines.length; }
}
