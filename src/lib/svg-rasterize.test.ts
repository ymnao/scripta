import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom には Image / canvas が完全には無いので mock を仕込む
class MockImage {
	naturalWidth = 200;
	naturalHeight = 100;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	private _src = "";
	get src(): string {
		return this._src;
	}
	set src(v: string) {
		this._src = v;
		// 非同期で onload を発火
		queueMicrotask(() => {
			if (MockImage.failNext) {
				MockImage.failNext = false;
				this.onerror?.();
			} else {
				this.onload?.();
			}
		});
	}
	static failNext = false;
}
// biome-ignore lint/suspicious/noExplicitAny: テスト用 global stub
(globalThis as any).Image = MockImage;

// canvas → toDataURL stub
const mockGetContext = vi.fn(() => ({
	fillStyle: "",
	fillRect: vi.fn(),
	scale: vi.fn(),
	drawImage: vi.fn(),
}));
const mockToDataURL = vi.fn(() => "data:image/png;base64,STUB");

const originalCreateElement = document.createElement.bind(document);
document.createElement = ((tag: string) => {
	if (tag === "canvas") {
		const el = originalCreateElement("canvas");
		// biome-ignore lint/suspicious/noExplicitAny: stub for testing
		el.getContext = mockGetContext as any;
		// biome-ignore lint/suspicious/noExplicitAny: stub for testing
		el.toDataURL = mockToDataURL as any;
		return el;
	}
	return originalCreateElement(tag);
	// biome-ignore lint/suspicious/noExplicitAny: stub for testing
}) as any;

// URL.createObjectURL / revokeObjectURL stub
// biome-ignore lint/suspicious/noExplicitAny: テスト用 global stub
(globalThis as any).URL.createObjectURL = vi.fn(() => "blob:mock-url");
// biome-ignore lint/suspicious/noExplicitAny: テスト用 global stub
(globalThis as any).URL.revokeObjectURL = vi.fn();

const { svgToPng, stripForeignObjects } = await import("./svg-rasterize");

describe("svgToPng (#106)", () => {
	beforeEach(() => {
		mockToDataURL.mockClear();
		mockGetContext.mockClear();
		MockImage.failNext = false;
		mockToDataURL.mockImplementation(() => "data:image/png;base64,STUB");
	});

	it("SVG 文字列から PNG data URL を生成する", async () => {
		const svg = '<svg viewBox="0 0 200 100" width="200" height="100"><text>X</text></svg>';
		const png = await svgToPng(svg);
		expect(png).toBe("data:image/png;base64,STUB");
		expect(mockToDataURL).toHaveBeenCalledWith("image/png");
	});

	it("scale オプションで canvas 寸法を scale 倍にする", async () => {
		const svg = '<svg viewBox="0 0 200 100" width="200" height="100"></svg>';
		await svgToPng(svg, { scale: 3 });
		// MockImage は naturalWidth=200, naturalHeight=100 を返す
		const ctxResult = mockGetContext.mock.results[0]?.value;
		expect(ctxResult?.scale).toHaveBeenCalledWith(3, 3);
	});

	it("backgroundColor オプションで canvas を塗りつぶす", async () => {
		const svg = '<svg viewBox="0 0 200 100" width="200" height="100"></svg>';
		await svgToPng(svg, { backgroundColor: "#fff" });
		const ctxResult = mockGetContext.mock.results[0]?.value;
		expect(ctxResult?.fillStyle).toBe("#fff");
		expect(ctxResult?.fillRect).toHaveBeenCalled();
	});

	it("Image load 失敗時は reject する", async () => {
		MockImage.failNext = true;
		const svg = '<svg viewBox="0 0 200 100" width="200" height="100"></svg>';
		await expect(svgToPng(svg)).rejects.toThrow("Failed to decode SVG into Image element");
	});

	it("canvas toDataURL が SecurityError を投げたら reject する（foreignObject taint 等）", async () => {
		mockToDataURL.mockImplementationOnce(() => {
			throw new Error("Tainted canvas");
		});
		const svg = '<svg viewBox="0 0 200 100" width="200" height="100"></svg>';
		await expect(svgToPng(svg)).rejects.toThrow("Tainted canvas");
	});
});

describe("stripForeignObjects (#106 canvas taint 防止)", () => {
	it("foreignObject タグを内側の HTML ごと除去する", () => {
		const svg =
			'<svg><foreignObject x="0" y="0" width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml">Label</div></foreignObject><rect/></svg>';
		const out = stripForeignObjects(svg);
		expect(out).not.toContain("foreignObject");
		expect(out).not.toContain("Label");
		expect(out).toContain("<rect/>");
	});

	it("複数の foreignObject を全部除去する", () => {
		const svg =
			"<svg><foreignObject>A</foreignObject><text>keep</text><foreignObject>B</foreignObject></svg>";
		const out = stripForeignObjects(svg);
		expect(out).not.toContain("foreignObject");
		expect(out).toContain("<text>keep</text>");
	});

	it("foreignObject が無い SVG は変更しない", () => {
		const svg = "<svg><text>only</text></svg>";
		expect(stripForeignObjects(svg)).toBe(svg);
	});
});
