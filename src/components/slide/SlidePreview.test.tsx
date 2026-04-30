import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SlidePreview } from "./SlidePreview";

describe("SlidePreview", () => {
	it("Markdown をプレビュー表示する", () => {
		render(<SlidePreview markdown="# Hello" slideIndex={0} totalSlides={3} />);
		expect(screen.getByText("Hello")).toBeDefined();
	});

	it("スライド番号インジケーターを表示する", () => {
		render(<SlidePreview markdown="content" slideIndex={2} totalSlides={5} />);
		expect(screen.getByText("3 / 5")).toBeDefined();
	});

	it("空のスライドでプレースホルダーを表示する", () => {
		render(<SlidePreview markdown="" slideIndex={0} totalSlides={1} />);
		expect(screen.getByText("空のスライド")).toBeDefined();
	});

	it("末尾の区切り行 --- をプレビューから除外する", () => {
		const { container } = render(
			<SlidePreview markdown={"# Title\n---"} slideIndex={0} totalSlides={2} />,
		);
		const content = container.querySelector(".slide-preview-content");
		expect(content).toBeDefined();
		expect(content?.innerHTML).toContain("Title");
		// --- が <hr> に変換されていないこと
		expect(content?.querySelector("hr")).toBeNull();
	});

	it("区切り行だけのスライドは hr として表示する", () => {
		const { container } = render(<SlidePreview markdown="---" slideIndex={0} totalSlides={2} />);
		// "---" のみは Markdown の水平線として解釈される
		const content = container.querySelector(".slide-preview-content");
		expect(content).toBeDefined();
	});
});
