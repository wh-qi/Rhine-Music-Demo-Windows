import * as THREE from "three";
import type { MusicSelectionLighting } from "./music-lighting";
import type { ArchiveRecord } from "./data";
import { MUSIC_COVER, createAlbumPrintMaterial } from "./music-model.ts";

// Paper insert inside the thin lid, shared by shelf, selection and viewer.
export const COVER_SIZE = MUSIC_COVER;
export type CoverImage = { source: CanvasImageSource; width: number; height: number };
type DecodedCoverImage = CoverImage & { decodedSize: number; pixels: number };
type DecodeJob = { url: string; generation: number; size: number; resolve: (image: DecodedCoverImage | undefined) => void; image?: HTMLImageElement };
export const COVER_PAINT_SIZE = 1024;
// 每帧留给图集的时间预算（毫秒）。滚动时不把整帧堵死，代价是封面晚几帧出现。
export const COVER_ATLAS_BUDGET_MS = 2;
// 滚动过快时队列的保险丝；溢出的都是已经过期的任务，丢弃即可。
const COVER_ATLAS_QUEUE_LIMIT = 512;
// 超过这么久没有 pump 驱动，就认为没有渲染循环（离屏校验、测试宿主），
// 此时必须同步执行，否则排队的绘制永远不会发生。
const COVER_ATLAS_PUMP_TIMEOUT_MS = 250;
// Use the same UV margin at every texture resolution. A fixed two-pixel inset
// made the 256px atlas artwork smaller than its 1024px lifted/returning copy.
export const COVER_INSET = 1 / 64;
const COVER_PAINT_MARGIN = COVER_PAINT_SIZE * COVER_INSET;

export function containCover(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
) {
  const scale = Math.min(
    boxWidth / Math.max(1, width),
    boxHeight / Math.max(1, height),
  );
  const drawnWidth = width * scale,
    drawnHeight = height * scale;
  return {
    x: (boxWidth - drawnWidth) / 2,
    y: (boxHeight - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}

export function paintCover(
  canvas: HTMLCanvasElement,
  record: Pick<ArchiveRecord, "title"> | undefined,
  image?: CoverImage,
) {
  const context = canvas.getContext("2d")!;
  // Paint in one logical coordinate space, including fallback art and labels.
  // Ownership can move between atlas/selection/snapshot without rescaling art.
  const width = COVER_PAINT_SIZE,
    height = COVER_PAINT_SIZE,
    margin = COVER_PAINT_MARGIN;
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  context.clearRect(0, 0, width, height);
  if (image) {
    const box = containCover(image.width, image.height, width - margin * 2, height - margin * 2);
    context.drawImage(
      image.source,
      box.x + margin,
      box.y + margin,
      box.width,
      box.height,
    );
    return;
  }
  // A missing cover is explicit and never substituted with another album's art.
  const size = height - margin * 2,
    left = (width - size) / 2;
  context.fillStyle = "#c9c9c4";
  context.fillRect(left, margin, size, size);
  context.strokeStyle = "#f8f7f1";
  context.lineWidth = Math.max(1, height / 180);
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.2, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.04, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "#3f4849";
  context.textAlign = "center";
  context.font = `500 ${Math.max(12, height * 0.045)}px sans-serif`;
  context.fillText(
    record?.title ?? "暂无专辑封面",
    width / 2,
    height * 0.8,
    height * 0.83,
  );
  context.font = `${Math.max(9, height * 0.025)}px sans-serif`;
  context.fillText(
    "LOCAL COLLECTION / NO COVER",
    width / 2,
    height * 0.87,
    height * 0.83,
  );
}

/** One fixed-size atlas for the visible pool, regardless of total library size. */
export class CoverAtlas {
  readonly array: THREE.InstancedMesh;
  readonly selected: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  private readonly work: Array<() => void> = [];
  private queueDropped = 0;
  private lastPump = Number.NEGATIVE_INFINITY;
  // 累计花在「从图集画布抠瓦片 + 上传」上的时间，用来算单个瓦片的真实成本。
  private uploadMs = 0;
  private directUploads = 0;
  private fallbackUploads = 0;
  // 再拆开：从 28MP 画布抠图（CPU/2D 画布）vs 交给 GPU 拷贝。
  private extractMs = 0;
  private copyMs = 0;
  private readonly atlasCanvas = document.createElement("canvas");
  private readonly selectedCanvas = document.createElement("canvas");
  private readonly tileCanvas = document.createElement("canvas");
  private readonly uploadCanvas = document.createElement("canvas");
  // 这两个画布只被 drawImage 读写、再交给 texSubImage2D。GPU 后备会让每次
  // 上传都触发一次画布回读加同步（实测整批 108MiB 要 7.4 秒，约 15MB/s）；
  // willReadFrequently 让它们留在系统内存里，整条链路变成内存拷贝加正常上传。
  // 注意：getContext 的选项只在第一次调用时生效，所以必须在这里建好。
  private readonly atlasContext: CanvasRenderingContext2D;
  private readonly uploadContext: CanvasRenderingContext2D;
  private readonly uploadTexture: THREE.Texture;
  private readonly atlas: THREE.CanvasTexture;
  private readonly selectedTexture: THREE.CanvasTexture;
  private readonly pendingImages = new Map<string, Promise<DecodedCoverImage | undefined>>();
  private readonly decodedImages = new Map<string, DecodedCoverImage | undefined>();
  private readonly decodeJobs = new Map<string, DecodeJob>();
  private readonly decodeQueue: DecodeJob[] = [];
  private readonly activeJobs = new Set<DecodeJob>();
  private readonly dirtySlots = new Set<number>();
  private readonly coverReady: THREE.InstancedBufferAttribute;
  private gpuInitialized = false;
  private uploadedBytes = 0;
  private uploadBatches = 0;
  private uploadedTiles = 0;
  private peakDecodes = 0;
  private decodedPixels = 0;
  private readonly maxDecodeConcurrency = 3;
  private readonly maxDecodedPixels = 4 * 1024 * 1024;
  private readonly slotKeys: (string | undefined)[];
  private readonly recordKeys = new WeakMap<ArchiveRecord, string>();
  private selectedRecord?: ArchiveRecord;
  private selectedKey?: string;
  private generation = 0;
  private disposed = false;
  private readonly columns = 16;
  private readonly rows: number;
  private readonly tileWidth: number;
  private readonly tileHeight: number;

  constructor(count: number, maxTextureSize: number, anisotropy: number, lighting?: MusicSelectionLighting) {
    this.rows = Math.ceil(count / this.columns);
    this.tileWidth = Math.min(
      256,
      Math.floor(maxTextureSize / this.columns),
      Math.floor(maxTextureSize / this.rows),
    );
    this.tileHeight = this.tileWidth;
    this.atlasCanvas.width = this.columns * this.tileWidth;
    this.atlasCanvas.height = this.rows * this.tileHeight;
    this.tileCanvas.width = this.tileWidth;
    this.tileCanvas.height = this.tileHeight;
    this.uploadCanvas.width = this.tileWidth;
    this.uploadCanvas.height = this.tileHeight;
    this.atlasContext = this.atlasCanvas.getContext("2d", { willReadFrequently: true })!;
    this.uploadContext = this.uploadCanvas.getContext("2d", { willReadFrequently: true })!;
    // This CPU-only source is copied directly into a subregion of the atlas.
    // It must never be initialized as a separate GPU texture.
    this.uploadTexture = new THREE.Texture(this.uploadCanvas);
    this.uploadTexture.colorSpace = THREE.SRGBColorSpace;
    this.uploadTexture.generateMipmaps = false;
    this.selectedCanvas.width = COVER_PAINT_SIZE;
    this.selectedCanvas.height = COVER_PAINT_SIZE;
    this.slotKeys = Array(count);
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    // No whole-atlas mip pyramid: independent transparent tile margins prevent bleed.
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = THREE.LinearFilter;
    // Atlas derivatives at steep shelf angles must not sample another tile.
    // Detailed selected art keeps anisotropic filtering on its own texture.
    this.atlas.anisotropy = 1;
    this.atlas.userData.maxAnisotropy = 1;
    this.selectedTexture = new THREE.CanvasTexture(this.selectedCanvas);
    this.selectedTexture.colorSpace = THREE.SRGBColorSpace;
    this.selectedTexture.anisotropy = Math.min(8, anisotropy);
    this.selectedTexture.userData.maxAnisotropy = 8;
    const geometry = new THREE.PlaneGeometry(
      COVER_SIZE.width,
      COVER_SIZE.height,
    ).translate(COVER_SIZE.x, COVER_SIZE.y, COVER_SIZE.z);
    const tileOffsets = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      tileOffsets.set(
        [
          (i % this.columns) / this.columns,
          1 - (Math.floor(i / this.columns) + 1) / this.rows,
          1 / this.columns,
          1 / this.rows,
        ],
        i * 4,
      );
    }
    geometry.setAttribute(
      "coverTile",
      new THREE.InstancedBufferAttribute(tileOffsets, 4),
    );
    this.coverReady = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.coverReady.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("coverReady", this.coverReady);
    // Instances, selected art and snapshots use one matte diffuse material and
    // one moving light field; no ownership-specific brightness/scale switches.
    const makePrint = (texture: THREE.Texture) => {
      const print = createAlbumPrintMaterial(texture);
      const compile = print.onBeforeCompile;
      print.onBeforeCompile = (shader, renderer) => {
        compile.call(print, shader, renderer);
        lighting?.shadePrint(shader);
      };
      print.customProgramCacheKey = () => `album-diffuse-print-${Boolean(lighting)}-v4`;
      return print;
    };
    const material = makePrint(this.atlas);
    const compileAtlas = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compileAtlas.call(material, shader, renderer);
      shader.vertexShader = "attribute vec4 coverTile;\nattribute float coverReady;\nvarying float vCoverReady;\nvarying vec4 vCoverTile;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nvCoverReady = coverReady;\nvCoverTile = coverTile;\nvMapUv = coverTile.xy + uv * coverTile.zw;",
      );
      shader.uniforms.coverAtlasTexel = { value: new THREE.Vector2(1 / this.atlasCanvas.width, 1 / this.atlasCanvas.height) };
      shader.fragmentShader = "varying float vCoverReady;\nvarying vec4 vCoverTile;\nuniform vec2 coverAtlasTexel;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>",
        "if (vCoverReady < 0.5) discard;\n" + THREE.ShaderChunk.map_fragment.replace("texture2D( map, vMapUv )", "texture2D( map, clamp(vMapUv, vCoverTile.xy + coverAtlasTexel * 0.5, vCoverTile.xy + vCoverTile.zw - coverAtlasTexel * 0.5) )"));
    };
    material.customProgramCacheKey = () => `album-diffuse-atlas-${Boolean(lighting)}-v4`;
    this.array = new THREE.InstancedMesh(geometry, material, count);
    this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.array.frustumCulled = false;
    this.array.visible = false;
    this.array.name = "Album cover atlas";
    this.array.receiveShadow = true;
    this.selected = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        COVER_SIZE.x,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      makePrint(this.selectedTexture),
    );
    this.selected.userData.albumCover = true;
    this.selected.visible = false;
    this.selected.name = "Selected album cover";
    this.selected.receiveShadow = true;
  }

  private cachedImage(url?: string) {
    if (!url || !this.decodedImages.has(url)) return undefined;
    const image = this.decodedImages.get(url);
    this.decodedImages.delete(url);
    this.decodedImages.set(url, image);
    return image;
  }

  private loadImage(url?: string, priority = false) {
    if (!url) return Promise.resolve(undefined);
    if (this.disposed) return Promise.resolve(undefined);
    const size = priority ? COVER_PAINT_SIZE : this.tileWidth;
    if (this.decodedImages.has(url)) {
      const cached = this.cachedImage(url);
      if (!cached || cached.decodedSize >= Math.min(size, Math.max(cached.width, cached.height))) return Promise.resolve(cached);
    }
    let pending = this.pendingImages.get(url);
    if (pending) {
      const job = this.decodeJobs.get(url);
      if (job && priority) {
        job.size = Math.max(job.size, size);
        const index = this.decodeQueue.indexOf(job);
        if (index > 0) { this.decodeQueue.splice(index, 1); this.decodeQueue.unshift(job); }
      }
      return pending;
    }
    let resolve!: DecodeJob["resolve"];
    pending = new Promise<DecodedCoverImage | undefined>((done) => { resolve = done; });
    const job: DecodeJob = { url, generation: this.generation, size, resolve };
    this.pendingImages.set(url, pending);
    this.decodeJobs.set(url, job);
    if (priority) this.decodeQueue.unshift(job);
    else this.decodeQueue.push(job);
    this.pumpDecodes();
    return pending;
  }

  private pumpDecodes() {
    while (!this.disposed && this.activeJobs.size < this.maxDecodeConcurrency && this.decodeQueue.length) {
      const job = this.decodeQueue.shift()!;
      const image = new Image();
      job.image = image;
      this.activeJobs.add(job);
      this.peakDecodes = Math.max(this.peakDecodes, this.activeJobs.size);
      image.crossOrigin = "anonymous";
      image.src = job.url;
      void image.decode()
        .then(() => {
          if (this.disposed || job.generation !== this.generation) return undefined;
          // Background slots only retain tile-sized thumbnails. Priority can
          // upgrade an in-flight source before its canvas is produced.
          const width = image.naturalWidth,
            height = image.naturalHeight;
          const scale = Math.min(1, job.size / Math.max(width, height));
          const source = document.createElement("canvas");
          source.width = Math.max(1, Math.round(width * scale));
          source.height = Math.max(1, Math.round(height * scale));
          source
            .getContext("2d")!
            .drawImage(image, 0, 0, source.width, source.height);
          return { source, width, height, decodedSize: Math.max(source.width, source.height), pixels: source.width * source.height };
        })
        .catch(() => undefined)
        .then((decoded) => {
          image.src = "";
          this.activeJobs.delete(job);
          if (!this.disposed && job.generation === this.generation) {
            this.decodedPixels -= this.decodedImages.get(job.url)?.pixels ?? 0;
            this.decodedImages.delete(job.url);
            this.decodedImages.set(job.url, decoded);
            this.decodedPixels += decoded?.pixels ?? 0;
            while (this.decodedImages.size > 48 || this.decodedPixels > this.maxDecodedPixels) {
              const first = this.decodedImages.keys().next().value!;
              this.decodedPixels -= this.decodedImages.get(first)?.pixels ?? 0;
              this.decodedImages.delete(first);
            }
          }
          if (this.decodeJobs.get(job.url) === job) {
            this.decodeJobs.delete(job.url);
            this.pendingImages.delete(job.url);
          }
          job.resolve(this.disposed || job.generation !== this.generation ? undefined : decoded);
          this.pumpDecodes();
        });
    }
  }

  private recordKey(record: ArchiveRecord | undefined) {
    // Description/metadata refreshes replace record objects without changing
    // their print. Cache only the visual identity, not the object reference.
    let key = record ? this.recordKeys.get(record) : "";
    if (record && key === undefined) {
      key = JSON.stringify([record.id, record.album?.coverUrl, record.title]);
      this.recordKeys.set(record, key);
    }
    return key!;
  }

  private copyCover(canvas: HTMLCanvasElement, key: string) {
    const selected = this.selectedKey === key && canvas !== this.selectedCanvas;
    const slot = selected ? -1 : this.slotKeys.indexOf(key);
    if (!selected && slot < 0) return false;
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    // Copy the whole painted tile, including its UV inset, exactly once.
    if (selected) context.drawImage(this.selectedCanvas, 0, 0, canvas.width, canvas.height);
    else context.drawImage(
      this.atlasCanvas,
      (slot % this.columns) * this.tileWidth,
      Math.floor(slot / this.columns) * this.tileHeight,
      this.tileWidth, this.tileHeight,
      0, 0, canvas.width, canvas.height,
    );
    return true;
  }

  /**
   * 解码完成的绘制排进队列，由 pump() 按帧预算排空。
   * 队列里的闭包自带 generation / slotKeys 校验，过期的执行时是空操作。
   */
  private enqueue(job: () => void) {
    // 没有渲染循环在驱动 pump 时不能排队，否则这一帧永远不会被画出来。
    if (performance.now() - this.lastPump > COVER_ATLAS_PUMP_TIMEOUT_MS) {
      job();
      return;
    }
    if (this.work.length >= COVER_ATLAS_QUEUE_LIMIT) {
      this.work.shift();
      this.queueDropped += 1;
    }
    this.work.push(job);
  }

  /** <html data-atlas-direct-upload="0"> 可强制走 Three.js 原路径，便于出问题时二分定位。
   *  校验宿主在 Node 里跑，没有 document。 */
  private legacyUpload(): boolean {
    const root = typeof document === "undefined" ? undefined : document.documentElement;
    return root?.dataset.atlasDirectUpload === "0";
  }

  /** 允许用 <html data-atlas-budget="…"> 在运行时调预算，便于测量，不改变默认值。 */
  private paintBudget(): number {
    // 校验宿主在 Node 里跑，没有 document。
    const root = typeof document === "undefined" ? undefined : document.documentElement;
    const raw = Number(root?.dataset.atlasBudget);
    return Number.isFinite(raw) && raw >= 0 ? raw : COVER_ATLAS_BUDGET_MS;
  }

  /**
   * 把一个瓦片从 uploadCanvas 直接传进图集的指定位置。
   *
   * 底层就是 Three.js 的 copyTextureToTexture 在 CPU 分支里做的那一句
   * texSubImage2D（three.module.js:19170），这里只是把它外面那圈包装去掉：
   * 那边每次调用要做 5 次 gl.getParameter（同步 GPU 往返，实测约 28ms）
   * 加 13 次 pixelStorei 和一次格式转换。参数完全对齐，结果应逐像素一致。
   */
  private uploadTileDirect(renderer: THREE.WebGLRenderer, x: number, y: number): boolean {
    // 直传依赖 Three.js 的内部字段。任何一项对不上就交回 copyTextureToTexture，
    // 回退次数会记进 fallbackUploads，不会被静默吞掉。
    if (typeof renderer?.getContext !== "function") return false;
    if (typeof renderer.properties?.get !== "function") return false;
    if (typeof renderer.state?.bindTexture !== "function") return false;
    // 直传写死了 RGBA/UNSIGNED_BYTE；图集不是这个组合时交回 Three 处理。
    if (this.atlas.format !== THREE.RGBAFormat || this.atlas.type !== THREE.UnsignedByteType) return false;
    // Three.js r183 只支持 WebGL2，这里的 UNPACK_* 常量和画布源的 texSubImage2D
    // 重载都是 WebGL2 专有，联合类型上看不到，所以明确收窄。
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const stored = renderer.properties.get(this.atlas) as { __webglTexture?: WebGLTexture } | undefined;
    const target = stored?.__webglTexture;
    if (!target) return false;
    // 用 Three 自己的 state 绑定，避免与它的 GL 状态缓存不同步。槽位取 0：
    // 本方法在 composer.render() 之前调用，没有绘制在飞行中。
    renderer.state.bindTexture(gl.TEXTURE_2D, target, gl.TEXTURE0);
    // 这三个必须和 Three.js 从 dstTexture 取值的方式完全一致
    // （three.module.js:19038-19040）。图集是 CanvasTexture，flipY 默认为 true；
    // 目标行的翻转已经由调用方算好，两者配合才正立。设错方向会让每个瓦片上下颠倒。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this.atlas.flipY ? 1 : 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this.atlas.premultiplyAlpha ? 1 : 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, this.atlas.unpackAlignment);
    // Three 的 uploadTexture 不会设置这五个；留下上一个调用方的值会读错行。
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    try {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, x, y, this.tileWidth, this.tileHeight,
        gl.RGBA, gl.UNSIGNED_BYTE, this.uploadCanvas,
      );
    } catch {
      // 上下文丢失等情况交回 Three，由它的路径去暴露问题。
      return false;
    }
    return true;
  }

  /**
   * 每帧调用：先按时间预算画排队的封面，再用剩余预算上传瓦片。
   * 把「这一帧要做多少图集工作」从瓦片数量改成真实耗时，避免单帧被堵住。
   */
  pump(renderer: THREE.WebGLRenderer, budgetMs = this.paintBudget(), maxTiles = 8) {
    this.lastPump = performance.now();
    const deadline = this.lastPump + Math.max(0, budgetMs);
    while (this.work.length && performance.now() < deadline) this.work.shift()!();
    return this.flushUploads(renderer, maxTiles, deadline);
  }

  setSlot(slot: number, record: ArchiveRecord | undefined) {
    const key = this.recordKey(record);
    if (this.slotKeys[slot] === key) return;
    const image = this.cachedImage(record?.album?.coverUrl);
    // Reuse the target album's existing print before assigning this slot's
    // identity; otherwise the lookup could copy the slot's previous album.
    if (image) paintCover(this.tileCanvas, record, image);
    else if (!this.copyCover(this.tileCanvas, key)) paintCover(this.tileCanvas, record);
    this.slotKeys[slot] = key;
    // A recycled instance must not briefly display the previous album while
    // its new tile waits for the bounded GPU upload budget.
    this.coverReady.setX(slot, 0);
    this.coverReady.needsUpdate = true;
    const generation = this.generation;
    const draw = (image?: CoverImage) => {
      if (this.disposed || generation !== this.generation || this.slotKeys[slot] !== key) return;
      if (image) paintCover(this.tileCanvas, record, image);
      const x = (slot % this.columns) * this.tileWidth,
        y = Math.floor(slot / this.columns) * this.tileHeight;
      const context = this.atlasContext;
      context.clearRect(x, y, this.tileWidth, this.tileHeight);
      context.drawImage(this.tileCanvas, x, y);
      this.dirtySlots.add(slot);
    };
    draw();
    if (!image) void this.loadImage(record?.album?.coverUrl).then((loaded) => {
      if (loaded) this.enqueue(() => draw(loaded));
    });
  }

  async select(record: ArchiveRecord | undefined) {
    this.selectedRecord = record;
    const key = this.recordKey(record);
    if (this.selectedKey === key) return;
    const generation = this.generation;
    const cached = this.cachedImage(record?.album?.coverUrl);
    if (cached) paintCover(this.selectedCanvas, record, cached);
    else if (!this.copyCover(this.selectedCanvas, key)) paintCover(this.selectedCanvas, record);
    this.selectedKey = key;
    this.selectedTexture.needsUpdate = true;
    if (cached && cached.decodedSize >= Math.min(COVER_PAINT_SIZE, Math.max(cached.width, cached.height))) return;
    const image = await this.loadImage(record?.album?.coverUrl, true);
    if (
      !image ||
      this.disposed ||
      generation !== this.generation ||
      this.selectedKey !== key
    )
      return;
    paintCover(this.selectedCanvas, record, image);
    this.selectedTexture.needsUpdate = true;
  }

  snapshot(mesh: THREE.Mesh) {
    const canvas = document.createElement("canvas");
    canvas.width = this.selectedCanvas.width;
    canvas.height = this.selectedCanvas.height;
    canvas.getContext("2d")!.drawImage(this.selectedCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.selectedTexture.anisotropy;
    mesh.material = this.selected.material.clone();
    mesh.material.onBeforeCompile = this.selected.material.onBeforeCompile;
    mesh.material.customProgramCacheKey = this.selected.material.customProgramCacheKey;
    (mesh.material as THREE.MeshLambertMaterial).map = texture;
    const record = this.selectedRecord;
    mesh.userData.coverDisposed = false;
    void this.loadImage(record?.album?.coverUrl, true).then((image) => {
      if (!image || mesh.userData.coverDisposed || this.disposed) return;
      paintCover(canvas, record, image);
      texture.needsUpdate = true;
    });
  }

  /** Up to 8 × 256² RGBA pixels (2 MiB), instead of re-uploading 108 MiB. */
  flushUploads(renderer: THREE.WebGLRenderer, maxTiles = 8, deadline?: number) {
    if (this.disposed || !this.dirtySlots.size) return 0;
    if (!this.gpuInitialized) {
      // Allocate immutable GPU storage without synchronously uploading the
      // full CPU canvas. Subsequent slots arrive through texSubImage2D copies.
      this.atlas.source.dataReady = false;
      try { renderer.initTexture(this.atlas); this.gpuInitialized = true; }
      finally { this.atlas.source.dataReady = true; }
    }
    const startedAt = performance.now();
    const context = this.uploadContext;
    const destination = new THREE.Vector2();
    let uploaded = 0;
    const legacy = this.legacyUpload();
    const limit = Math.max(1, Math.min(64, Math.floor(maxTiles) || 8));
    for (const slot of this.dirtySlots) {
      const x = (slot % this.columns) * this.tileWidth;
      const y = Math.floor(slot / this.columns) * this.tileHeight;
      context.clearRect(0, 0, this.tileWidth, this.tileHeight);
      const extractStart = performance.now();
      context.drawImage(this.atlasCanvas, x, y, this.tileWidth, this.tileHeight, 0, 0, this.tileWidth, this.tileHeight);
      this.extractMs += performance.now() - extractStart;
      // Canvas rows run downwards; WebGL destination origins run upwards.
      destination.set(x, this.atlasCanvas.height - y - this.tileHeight);
      const copyStart = performance.now();
      // 默认走直传：Three.js r183 的 copyTextureToTexture 每次要做 5 次
      // gl.getParameter（同步 GPU 往返），实测单瓦片 22-26ms，而底下那句
      // texSubImage2D 本身只要 0.02ms。取不到内部纹理或格式不符时自动回退。
      if (!legacy && this.uploadTileDirect(renderer, x, destination.y)) {
        this.directUploads += 1;
      } else {
        renderer.copyTextureToTexture(this.uploadTexture, this.atlas, null, destination);
        this.fallbackUploads += 1;
      }
      this.copyMs += performance.now() - copyStart;
      this.dirtySlots.delete(slot);
      this.coverReady.setX(slot, 1);
      this.uploadedBytes += this.tileWidth * this.tileHeight * 4;
      this.uploadedTiles++;
      if (++uploaded >= limit) break;
      // dirtySlots 是边走边删的，中途停下是安全的：剩下的下一帧继续。
      if (deadline !== undefined && performance.now() >= deadline) break;
    }
    if (uploaded) { this.coverReady.needsUpdate = true; this.uploadBatches++; }
    this.uploadMs += performance.now() - startedAt;
    return uploaded;
  }

  /** Bounded wait for the currently visible requests; no whole-library preload. */
  async prepareVisible(timeoutMs = 1200) {
    const pending = [...this.pendingImages.values()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = !pending.length || await Promise.race([
      Promise.all(pending).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, Math.min(3000, timeoutMs))); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return { settled, ...this.getStats() };
  }

  getStats() {
    return {
      atlasWidth: this.atlasCanvas.width, atlasHeight: this.atlasCanvas.height,
      atlasBytes: this.atlasCanvas.width * this.atlasCanvas.height * 4,
      tileWidth: this.tileWidth, tileHeight: this.tileHeight,
      activeDecodes: this.activeJobs.size, queuedDecodes: this.decodeQueue.length,
      pendingImages: this.pendingImages.size, peakDecodes: this.peakDecodes,
      cachedImages: this.decodedImages.size, cachedBytes: this.decodedPixels * 4,
      dirtyTiles: this.dirtySlots.size, uploadedTiles: this.uploadedTiles,
      uploadedBytes: this.uploadedBytes, uploadBatches: this.uploadBatches,
      gpuInitialized: this.gpuInitialized,
      paintQueue: this.work.length, queueDropped: this.queueDropped, atlasBudgetMs: this.paintBudget(),
      uploadMs: Math.round(this.uploadMs), extractMs: Math.round(this.extractMs), copyMs: Math.round(this.copyMs),
      directUploads: this.directUploads, fallbackUploads: this.fallbackUploads,
    };
  }

  private cancelDecodes() {
    for (const job of this.decodeQueue.splice(0)) job.resolve(undefined);
    for (const job of this.activeJobs) { job.resolve(undefined); if (job.image) job.image.src = ""; }
    this.pendingImages.clear();
    this.decodeJobs.clear();
    this.decodedImages.clear();
    this.decodedPixels = 0;
  }

  reset() {
    this.generation++;
    this.slotKeys.fill(undefined);
    this.selectedRecord = undefined;
    this.selectedKey = undefined;
    this.cancelDecodes();
    this.dirtySlots.clear();
    this.coverReady.array.fill(0);
    this.coverReady.needsUpdate = true;
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.cancelDecodes();
    this.dirtySlots.clear();
    this.work.length = 0;
    this.uploadTexture.dispose();
    this.atlas.dispose();
    this.selectedTexture.dispose();
    this.array.geometry.dispose();
    (this.array.material as THREE.Material).dispose();
    this.selected.geometry.dispose();
    this.selected.material.dispose();
    this.atlasCanvas.width = this.atlasCanvas.height = 1;
    this.selectedCanvas.width = this.selectedCanvas.height = 1;
    this.tileCanvas.width = this.tileCanvas.height = 1;
    this.uploadCanvas.width = this.uploadCanvas.height = 1;
  }
}
