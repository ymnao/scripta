import { describe, expect, it } from "vitest";
import { findSlideAtCursor, parseSlides } from "./slide-parser";

describe("parseSlides", () => {
	it("空のドキュメントでは1枚のスライドを返す", () => {
		const slides = parseSlides("");
		expect(slides).toEqual([{ content: "", from: 0, to: 0 }]);
	});

	it("区切りなしのドキュメントでは1枚のスライドを返す", () => {
		const text = "# Hello\n\nWorld";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(1);
		expect(slides[0].content).toBe(text);
		expect(slides[0].from).toBe(0);
		expect(slides[0].to).toBe(text.length);
	});

	it("基本的な --- 分割", () => {
		const text = "# Slide 1\n---\n# Slide 2\n---\n# Slide 3";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(3);
		expect(slides[0].content).toBe("# Slide 1\n---");
		expect(slides[1].content).toBe("# Slide 2\n---");
		expect(slides[2].content).toBe("# Slide 3");
	});

	it("from/to オフセットが正確", () => {
		const text = "AAA\n---\nBBB\n---\nCCC";
		const slides = parseSlides(text);

		expect(slides[0].from).toBe(0);
		expect(slides[0].to).toBe(7); // "AAA\n---" = 7 chars
		expect(text.slice(slides[0].from, slides[0].to)).toBe("AAA\n---");

		expect(slides[1].from).toBe(8);
		expect(slides[1].to).toBe(15); // "BBB\n---" = 7 chars
		expect(text.slice(slides[1].from, slides[1].to)).toBe("BBB\n---");

		expect(slides[2].from).toBe(16);
		expect(slides[2].to).toBe(19);
		expect(text.slice(slides[2].from, slides[2].to)).toBe("CCC");
	});

	it("コードブロック内の --- をスキップ", () => {
		const text = "# Slide 1\n\n```\n---\n```\n\n---\n# Slide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(2);
		expect(slides[0].content).toContain("```\n---\n```");
		expect(slides[1].content).toBe("# Slide 2");
	});

	it("チルダコードブロック内の --- をスキップ", () => {
		const text = "# Slide 1\n\n~~~\n---\n~~~\n\n---\n# Slide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(2);
	});

	it("YAML frontmatter をスキップ", () => {
		const text = "---\ntitle: My Slides\n---\n# Slide 1\n---\n# Slide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(2);
		expect(slides[0].content).toContain("title: My Slides");
		expect(slides[0].content).toContain("# Slide 1");
		expect(slides[1].content).toBe("# Slide 2");
	});

	it("先頭の --- を YAML でなければスライド区切りとして扱う", () => {
		const text = "---\n# Slide 1\n---\n# Slide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(3);
		expect(slides[0].content).toBe("---");
		expect(slides[1].content).toBe("# Slide 1\n---");
		expect(slides[2].content).toBe("# Slide 2");
	});

	it("先頭 --- の直後が空行のみの場合は frontmatter とみなさない", () => {
		const text = "---\n\n# Slide 1\n---\n# Slide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(3);
	});

	it("先頭区切り後に key: 風の行とフリーテキストが混在する場合は frontmatter とみなさない", () => {
		const text = "---\ntitle: Intro\nspeaker notes\n---\n# Slide 2";
		const slides = parseSlides(text);
		// "speaker notes" は YAML として不正なのでスライド区切りとして扱う
		expect(slides).toHaveLength(3);
		expect(slides[0].content).toBe("---");
		expect(slides[1].content).toBe("title: Intro\nspeaker notes\n---");
		expect(slides[2].content).toBe("# Slide 2");
	});

	it("YAML コメントから始まる frontmatter をスキップ", () => {
		const text = "---\n# comment\ntitle: X\n---\n# Slide 1\n---\n# Slide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(2);
		expect(slides[0].content).toContain("# Slide 1");
		expect(slides[1].content).toBe("# Slide 2");
	});

	it("複数の YAML フィールドを含む frontmatter をスキップ", () => {
		const text = "---\ntitle: Test\nauthor: Alice\ndate: 2025-01-01\n---\nContent\n---\nSlide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(2);
		expect(slides[0].content).toContain("title: Test");
		expect(slides[0].content).toContain("Content");
	});

	it("前後に空白がある --- も認識する", () => {
		const text = "Slide 1\n  ---  \nSlide 2";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(2);
	});

	it("連続する区切りの間に空のスライドが生成される", () => {
		const text = "A\n---\n---\nB";
		const slides = parseSlides(text);
		expect(slides).toHaveLength(3);
		expect(slides[1].content).toBe("---");
	});
});

describe("findSlideAtCursor", () => {
	it("カーソル位置からスライドを特定する", () => {
		const text = "AAA\n---\nBBB\n---\nCCC";
		const slides = parseSlides(text);

		expect(findSlideAtCursor(slides, 0)).toBe(0); // "A"
		expect(findSlideAtCursor(slides, 2)).toBe(0); // "A" の中
		expect(findSlideAtCursor(slides, 8)).toBe(1); // "BBB" の先頭
		expect(findSlideAtCursor(slides, 16)).toBe(2); // "CCC" の先頭
	});

	it("空のスライドリストで 0 を返す", () => {
		const slides = parseSlides("");
		expect(findSlideAtCursor(slides, 0)).toBe(0);
	});
});
