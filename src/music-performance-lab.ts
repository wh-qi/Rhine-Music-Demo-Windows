import "./music-lighting-lab.css";

export type PerformanceSample = {
  fps: number;
  p50: number;
  p95: number;
  max: number;
  over50: number;
  samples: number;
  cpuP95: number;
  render: string;
  note: string;
};

type PerformanceLabOptions = {
  enabled: boolean;
  onClose: () => void;
};

/** 实时性能面板：与光效、动画速度两个开发者面板同构，浮在界面上，
 *  这样滚动时也能一直看着读数。 */
export function setupPerformanceLab(host: HTMLElement, options: PerformanceLabOptions) {
  const panel = document.createElement("aside");
  panel.className = "lighting-lab performance-lab";
  panel.hidden = !options.enabled;
  panel.setAttribute("aria-label", "实时性能开发者调试");
  panel.dataset.expanded = "true";
  panel.innerHTML = `
    <div class="lighting-lab-header">
      <button class="lighting-lab-heading" type="button" aria-controls="performance-lab-readouts" aria-expanded="true">
        <span><b>DEV</b> PERFORMANCE<small>帧率与帧时间</small></span>
        <span class="lighting-lab-chevron" aria-hidden="true">−</span>
      </button>
      <button class="lighting-lab-close" type="button" aria-label="关闭性能调试面板" title="关闭面板">×</button>
    </div>
    <div id="performance-lab-readouts" class="lighting-lab-controls">
      <div class="lighting-lab-sliders">
        <label><span>帧率</span><output id="performance-lab-fps">—</output></label>
        <label><span>帧时间 p50/p95/最大</span><output id="performance-lab-frame">—</output></label>
        <label><span>长帧 &gt; 50 ms</span><output id="performance-lab-over">—</output></label>
        <label><span>CPU 提交</span><output id="performance-lab-cpu">—</output></label>
        <label><span>渲染分辨率</span><output id="performance-lab-render">—</output></label>
      </div>
      <p class="lighting-lab-timing-note" id="performance-lab-note">等第一帧…</p>
    </div>`;
  host.append(panel);
  const heading = panel.querySelector<HTMLButtonElement>(".lighting-lab-heading")!;
  const readout = <T extends HTMLElement>(id: string) => panel.querySelector<T>(`#${id}`)!;
  const fields = {
    fps: readout<HTMLOutputElement>("performance-lab-fps"),
    frame: readout<HTMLOutputElement>("performance-lab-frame"),
    over: readout<HTMLOutputElement>("performance-lab-over"),
    cpu: readout<HTMLOutputElement>("performance-lab-cpu"),
    render: readout<HTMLOutputElement>("performance-lab-render"),
    note: readout<HTMLElement>("performance-lab-note"),
  };
  const expand = (expanded: boolean) => {
    panel.dataset.expanded = String(expanded);
    heading.setAttribute("aria-expanded", String(expanded));
    panel.querySelector(".lighting-lab-chevron")!.textContent = expanded ? "−" : "+";
  };
  heading.addEventListener("click", () => expand(panel.dataset.expanded !== "true"));
  panel.querySelector(".lighting-lab-close")!.addEventListener("click", () => {
    panel.hidden = true;
    options.onClose();
  });
  // 面板内的滚轮、指针与按键不应穿透到专辑架。
  for (const type of ["wheel", "pointerdown", "keydown", "keyup"] as const) {
    panel.addEventListener(type, (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") return;
      event.stopPropagation();
    });
  }
  return {
    get visible() { return !panel.hidden; },
    setEnabled(enabled: boolean) { panel.hidden = !enabled; },
    focus() {
      panel.hidden = false;
      expand(true);
      heading.focus({ preventScroll: true });
      panel.scrollIntoView({ block: "nearest" });
    },
    /** 由帧循环节流调用；面板隐藏时立即返回，不产生任何开销。 */
    update(sample: PerformanceSample) {
      if (panel.hidden) return;
      fields.fps.value = `${sample.fps.toFixed(0)} fps`;
      fields.frame.value = `${sample.p50.toFixed(1)} / ${sample.p95.toFixed(1)} / ${sample.max.toFixed(1)} ms`;
      fields.over.value = `${sample.over50} / ${sample.samples} 帧`;
      fields.cpu.value = `${sample.cpuP95.toFixed(1)} ms`;
      fields.render.value = sample.render;
      fields.note.textContent = sample.note;
    },
  };
}
