export interface SlideSection {
	content: string;
	from: number;
	to: number;
}

/**
 * スライド deck に適用可能なテーマ。app theme と同じ 2 値だが、frontmatter override
 * (Fable #12) / preview / PDF の 3 経路で共有する型として types/slide に置く。
 */
export type SlideTheme = "light" | "dark";

// スライドの論理サイズ。16:9。SlidePreview は transform: scale() でコンテナに fit、
// PDF export は printToPDF の pageSize (μm) にこのピクセル寸法を 96dpi 換算で流し込む。
// 両 consumer で同じ WYSIWYG 前提を共有するため、UI 層でなくドメイン層に置く。
export const SLIDE_LOGICAL_WIDTH = 1280;
export const SLIDE_LOGICAL_HEIGHT = 720;
// スライド外周の余白。SlidePreview と PDF export の両方が同じ値を使うことで、
// 見え方 (WYSIWYG) を一致させる。旧 SlidePreview の Tailwind `p-16` (= 4rem) を
// px 固定に上げ、root font-size に依存しないよう altitude を揃えた。
export const SLIDE_LOGICAL_PADDING_PX = 64;

// Fable #13: SlideView の右側プレビューペイン幅を editor コンテナに対する比率で
// 保持する。極端な値だと片方のペインが潰れて操作不能になるため、min 0.2 / max
// 0.7 でクランプする。step は矢印キー操作 1 回あたりの ratio 増減（2%）。
// スライドドメインの UI tuning knob として同一モジュールに集約する（HANDOFF §84
// で SLIDE_PDF_PALETTE を types/slide に上げる altitude 方針を確立した継続）。
export const SLIDE_PREVIEW_WIDTH_RATIO_MIN = 0.2;
export const SLIDE_PREVIEW_WIDTH_RATIO_MAX = 0.7;
export const SLIDE_PREVIEW_WIDTH_RATIO_DEFAULT = 0.45;
export const SLIDE_PREVIEW_WIDTH_RATIO_STEP = 0.02;
