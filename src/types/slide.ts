export interface SlideSection {
	content: string;
	from: number;
	to: number;
}

// スライドの論理サイズ。16:9。SlidePreview は transform: scale() でコンテナに fit、
// PDF export は printToPDF の pageSize (μm) にこのピクセル寸法を 96dpi 換算で流し込む。
// 両 consumer で同じ WYSIWYG 前提を共有するため、UI 層でなくドメイン層に置く。
export const SLIDE_LOGICAL_WIDTH = 1280;
export const SLIDE_LOGICAL_HEIGHT = 720;
// スライド外周の余白。SlidePreview と PDF export の両方が同じ値を使うことで、
// 見え方 (WYSIWYG) を一致させる。旧 SlidePreview の Tailwind `p-16` (= 4rem) を
// px 固定に上げ、root font-size に依存しないよう altitude を揃えた。
export const SLIDE_LOGICAL_PADDING_PX = 64;
