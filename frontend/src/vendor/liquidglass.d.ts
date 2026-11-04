// vendor/liquidglass.js 里用到的部分的类型（完整类型见 npm 包 @ybouane/liquidglass 的 dist/*.d.ts）。
export type GlassConfig = {
  blurAmount: number;
  refraction: number;
  chromAberration: number;
  edgeHighlight: number;
  specular: number;
  fresnel: number;
  distortion: number;
  cornerRadius: number;
  zRadius: number;
  opacity: number;
  saturation: number;
  tintStrength: number;
  brightness: number;
  shadowOpacity: number;
  shadowSpread: number;
  shadowOffsetY: number;
  floating: boolean;
  button: boolean;
  bevelMode: number;
};

export declare class LiquidGlass {
  static init(options: { root: HTMLElement; glassElements?: HTMLElement[]; defaults?: Partial<GlassConfig> }): Promise<LiquidGlass>;
  readonly capture: { captureElement(el: HTMLElement, force?: boolean): Promise<void>; _capturing: Set<HTMLElement> };
  markChanged(el?: HTMLElement): void;
  destroy(): void;
}
