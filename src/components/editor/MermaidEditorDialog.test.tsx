import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock mermaid renderer
const mockRenderMermaid = vi.fn();
vi.mock("../../lib/mermaid", () => ({
	renderMermaid: (...args: unknown[]) => mockRenderMermaid(...args),
}));

// Mock theme store
vi.mock("../../stores/theme", () => ({
	useThemeStore: (selector: (s: { theme: string }) => unknown) => selector({ theme: "light" }),
}));

import { MermaidEditorDialog } from "./MermaidEditorDialog";

const defaultProps = {
	open: true,
	source: "graph TD\n  A-->B",
	onSave: vi.fn(),
	onCancel: vi.fn(),
};

function renderDialog(overrides: Partial<typeof defaultProps & { mode: "edit" | "insert" }> = {}) {
	const props = { ...defaultProps, ...overrides };
	if (vi.isMockFunction(props.onSave)) props.onSave.mockClear();
	if (vi.isMockFunction(props.onCancel)) props.onCancel.mockClear();
	return render(<MermaidEditorDialog {...props} />);
}

afterEach(() => {
	mockRenderMermaid.mockReset();
});

describe("MermaidEditorDialog", () => {
	it("open=false で非表示", () => {
		renderDialog({ open: false });
		expect(screen.queryByText("Mermaid エディタ")).not.toBeInTheDocument();
	});

	it("open=true で表示される", () => {
		renderDialog({ open: true });
		expect(screen.getByText("Mermaid エディタ")).toBeInTheDocument();
	});

	it("source の初期値が textarea に反映される", () => {
		renderDialog({ source: "graph LR\n  X-->Y" });
		expect(screen.getByRole("textbox")).toHaveValue("graph LR\n  X-->Y");
	});

	it("edit モードで「保存」ボタンが表示される", () => {
		renderDialog({ mode: "edit" });
		expect(screen.getByText("保存")).toBeInTheDocument();
	});

	it("insert モードで「挿入」ボタンが表示される", () => {
		renderDialog({ mode: "insert" });
		expect(screen.getByText("挿入")).toBeInTheDocument();
	});

	it("「キャンセル」で onCancel が呼ばれる", async () => {
		const onCancel = vi.fn();
		renderDialog({ onCancel });
		await userEvent.click(screen.getByText("キャンセル"));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("「保存」で onSave が現在の入力値で呼ばれる", async () => {
		const onSave = vi.fn();
		renderDialog({ onSave, source: "graph TD\n  A-->B" });
		await userEvent.click(screen.getByText("保存"));
		expect(onSave).toHaveBeenCalledWith("graph TD\n  A-->B");
	});

	it("入力を編集して「保存」→ 編集後の値で onSave が呼ばれる", async () => {
		const onSave = vi.fn();
		renderDialog({ onSave, source: "" });
		const textarea = screen.getByRole("textbox");
		await userEvent.type(textarea, "graph LR");
		await userEvent.click(screen.getByText("保存"));
		expect(onSave).toHaveBeenCalledWith("graph LR");
	});

	it("再オープン時に前回のキャンセル内容がリセットされる", async () => {
		const { rerender } = renderDialog({ source: "original" });
		const textarea = screen.getByRole("textbox");

		// ユーザーが入力を変更
		await userEvent.clear(textarea);
		await userEvent.type(textarea, "modified");
		expect(textarea).toHaveValue("modified");

		// ダイアログを閉じる
		rerender(
			<MermaidEditorDialog
				open={false}
				source="original"
				onSave={defaultProps.onSave}
				onCancel={defaultProps.onCancel}
			/>,
		);

		// 同じ source で再オープン → original にリセットされる
		rerender(
			<MermaidEditorDialog
				open={true}
				source="original"
				onSave={defaultProps.onSave}
				onCancel={defaultProps.onCancel}
			/>,
		);

		expect(screen.getByRole("textbox")).toHaveValue("original");
	});

	it("挿入ダイアログの再オープン時に空にリセットされる", async () => {
		const { rerender } = renderDialog({ source: "", mode: "insert" });
		const textarea = screen.getByRole("textbox");

		await userEvent.type(textarea, "graph TD");
		expect(textarea).toHaveValue("graph TD");

		// 閉じて再オープン
		rerender(
			<MermaidEditorDialog
				open={false}
				source=""
				mode="insert"
				onSave={defaultProps.onSave}
				onCancel={defaultProps.onCancel}
			/>,
		);
		rerender(
			<MermaidEditorDialog
				open={true}
				source=""
				mode="insert"
				onSave={defaultProps.onSave}
				onCancel={defaultProps.onCancel}
			/>,
		);

		expect(screen.getByRole("textbox")).toHaveValue("");
	});

	it("IME変換中のCmd+EnterでonSaveが呼ばれない", () => {
		const onSave = vi.fn();
		renderDialog({ onSave });
		const textarea = screen.getByRole("textbox");

		fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, keyCode: 229 });

		expect(onSave).not.toHaveBeenCalled();
	});

	it("閉じた後に遅延 promise が解決してもプレビューに反映されない", async () => {
		let resolveRender: ((svg: string) => void) | null = null;
		mockRenderMermaid.mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					resolveRender = resolve;
				}),
		);

		vi.useFakeTimers({ shouldAdvanceTime: true });

		const { rerender } = renderDialog({ source: "graph TD\n  A-->B" });

		// デバウンス 300ms を進めてレンダリング開始
		await vi.advanceTimersByTimeAsync(400);
		expect(mockRenderMermaid).toHaveBeenCalled();

		// ダイアログを閉じる（promise はまだ pending）
		rerender(
			<MermaidEditorDialog
				open={false}
				source="graph TD\n  A-->B"
				onSave={defaultProps.onSave}
				onCancel={defaultProps.onCancel}
			/>,
		);

		// 閉じた後に promise 解決
		(resolveRender as ((svg: string) => void) | null)?.("<svg>old</svg>");
		await vi.advanceTimersByTimeAsync(0);

		// 別の source で再オープン
		rerender(
			<MermaidEditorDialog
				open={true}
				source="graph LR\n  X-->Y"
				onSave={defaultProps.onSave}
				onCancel={defaultProps.onCancel}
			/>,
		);

		// 古い SVG がプレビューに表示されていないこと
		expect(screen.queryByText((_, el) => el?.innerHTML === "<svg>old</svg>")).toBeNull();

		vi.useRealTimers();
	});
});
