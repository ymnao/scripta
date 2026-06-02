/**
 * SVG 内の `<foreignObject>` を全部 strip する。
 * foreignObject を含む SVG を `<img>` 経由 canvas にロードすると canvas tainted
 * → `toDataURL` が SecurityError。上流で `htmlLabels: false` 指定済みでも theme /
 * title / 特殊 shape で残ることがあるので、rasterize 直前 safety net として除去。
 */
export function stripForeignObjects(svg: string): string {
	return svg.replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "");
}

/**
 * SVG 文字列を PNG data URL にラスタライズする（#106 の Mermaid label 消失への
 * 根本対処）。`webContents.printToPDF` の印刷コンテキストでは SVG inline text の
 * 描画が複数レイヤーで不安定だが、PNG は bitmap なので確実に描画される。
 * 制約: foreignObject 非含 / intrinsic width/height 必須 / renderer process 限定。
 * 失敗時は呼出側で inline SVG fallback を選ぶ想定。
 */
export async function svgToPng(
	svg: string,
	options: { scale?: number; backgroundColor?: string } = {},
): Promise<string> {
	const scale = options.scale ?? 2;
	// canvas tainted を避けるため foreignObject を除去（htmlLabels: false 指定でも
	// 残ることがある）。
	const cleanedSvg = stripForeignObjects(svg);
	// font 読み込みが完了するまで待ってからラスタライズ（custom font の text 形状が
	// 安定するまで canvas に描画してしまうと、編集中のフォントに見える PNG が
	// 焼き付けられる）。
	if (typeof document !== "undefined" && document.fonts?.ready) {
		try {
			await document.fonts.ready;
		} catch {
			// fonts API が無いまたは reject された場合は無視して進める
		}
	}

	return new Promise((resolve, reject) => {
		const img = new Image();
		const svgBlob = new Blob([cleanedSvg], { type: "image/svg+xml;charset=utf-8" });
		const url = URL.createObjectURL(svgBlob);

		img.onload = () => {
			try {
				const naturalW = img.naturalWidth || img.width;
				const naturalH = img.naturalHeight || img.height;
				if (!naturalW || !naturalH) {
					URL.revokeObjectURL(url);
					reject(new Error("SVG has no intrinsic dimensions"));
					return;
				}
				const canvas = document.createElement("canvas");
				canvas.width = Math.ceil(naturalW * scale);
				canvas.height = Math.ceil(naturalH * scale);
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					URL.revokeObjectURL(url);
					reject(new Error("Failed to get canvas 2D context"));
					return;
				}
				if (options.backgroundColor) {
					ctx.fillStyle = options.backgroundColor;
					ctx.fillRect(0, 0, canvas.width, canvas.height);
				}
				ctx.scale(scale, scale);
				ctx.drawImage(img, 0, 0, naturalW, naturalH);
				URL.revokeObjectURL(url);
				try {
					const dataUrl = canvas.toDataURL("image/png");
					resolve(dataUrl);
				} catch (e) {
					// foreignObject 入り SVG だと canvas tainted で SecurityError になる
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			} catch (e) {
				URL.revokeObjectURL(url);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Failed to decode SVG into Image element"));
		};
		img.src = url;
	});
}
