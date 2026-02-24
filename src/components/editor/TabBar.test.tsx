import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../stores/workspace";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
	const onCloseTab = vi.fn();
	const onTabSelect = vi.fn();
	const onGoBack = vi.fn();
	const onGoForward = vi.fn();
	const onReorderTab = vi.fn();

	const defaultProps = {
		onCloseTab,
		onTabSelect,
		canGoBack: false,
		canGoForward: false,
		onGoBack,
		onGoForward,
		onReorderTab,
	};

	function setTabs(
		tabs: Array<{ id: number; path: string; dirty: boolean }>,
		activeTabId: number | null,
	) {
		useWorkspaceStore.setState({
			workspacePath: "/workspace",
			tabs: tabs.map((t) => ({
				...t,
				history: [t.path],
				historyIndex: 0,
			})),
			activeTabPath: tabs.find((t) => t.id === activeTabId)?.path ?? null,
			activeTabId,
		});
	}

	beforeEach(() => {
		onCloseTab.mockClear();
		onTabSelect.mockClear();
		onGoBack.mockClear();
		onGoForward.mockClear();
		onReorderTab.mockClear();
		useWorkspaceStore.setState({
			workspacePath: "/workspace",
			tabs: [],
			activeTabPath: null,
			activeTabId: null,
			_nextTabId: 1,
		});
	});

	it("renders tablist with aria-label", () => {
		render(<TabBar {...defaultProps} />);
		expect(screen.getByRole("tablist", { name: "Editor tabs" })).toBeInTheDocument();
	});

	it("renders empty when no tabs", () => {
		render(<TabBar {...defaultProps} />);
		expect(screen.queryByRole("tab")).not.toBeInTheDocument();
	});

	it("renders tab list with file names", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: false },
				{ id: 2, path: "/workspace/b.md", dirty: false },
			],
			1,
		);

		render(<TabBar {...defaultProps} />);
		expect(screen.getByText("a.md")).toBeInTheDocument();
		expect(screen.getByText("b.md")).toBeInTheDocument();
	});

	it("marks active tab with aria-selected", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: false },
				{ id: 2, path: "/workspace/b.md", dirty: false },
			],
			1,
		);

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");
	});

	it("calls onTabSelect with tab id on click", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: false },
				{ id: 2, path: "/workspace/b.md", dirty: false },
			],
			1,
		);

		render(<TabBar {...defaultProps} />);
		fireEvent.click(screen.getByText("b.md"));

		expect(onTabSelect).toHaveBeenCalledWith(2);
	});

	it("calls onCloseTab with tab id when close button is clicked", () => {
		setTabs([{ id: 1, path: "/workspace/a.md", dirty: false }], 1);

		render(<TabBar {...defaultProps} />);
		fireEvent.click(screen.getByLabelText("Close a.md"));

		expect(onCloseTab).toHaveBeenCalledWith(1);
	});

	it("shows dirty indicator for dirty tabs", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: true },
				{ id: 2, path: "/workspace/b.md", dirty: false },
			],
			1,
		);

		const { container } = render(<TabBar {...defaultProps} />);
		const dots = container.querySelectorAll(".rounded-full");
		expect(dots).toHaveLength(1);
	});

	it("announces unsaved changes via aria-label on dirty tab", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: true },
				{ id: 2, path: "/workspace/b.md", dirty: false },
			],
			1,
		);

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("aria-label", "a.md, unsaved changes");
		expect(tabs[1]).not.toHaveAttribute("aria-label");
	});

	it("calls onCloseTab with tab id when Delete key is pressed on focused tab", () => {
		setTabs([{ id: 1, path: "/workspace/a.md", dirty: false }], 1);

		render(<TabBar {...defaultProps} />);
		const tab = screen.getByRole("tab");
		fireEvent.keyDown(tab, { key: "Delete" });

		expect(onCloseTab).toHaveBeenCalledWith(1);
	});

	it("uses roving tabindex (active=0, others=-1)", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: false },
				{ id: 2, path: "/workspace/b.md", dirty: false },
			],
			2,
		);

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("tabindex", "-1");
		expect(tabs[1]).toHaveAttribute("tabindex", "0");
	});

	it("calls onTabSelect with tab id on arrow keys", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: false },
				{ id: 2, path: "/workspace/b.md", dirty: false },
				{ id: 3, path: "/workspace/c.md", dirty: false },
			],
			1,
		);

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		tabs[0].focus();

		fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[1]);
		expect(onTabSelect).toHaveBeenCalledWith(2);

		fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[2]);
		expect(onTabSelect).toHaveBeenCalledWith(3);

		// Wraps around
		fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[0]);
		expect(onTabSelect).toHaveBeenCalledWith(1);

		fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
		expect(document.activeElement).toBe(tabs[2]);
		expect(onTabSelect).toHaveBeenCalledWith(3);
	});

	it("calls onTabSelect with tab id on Home/End keys", () => {
		setTabs(
			[
				{ id: 1, path: "/workspace/a.md", dirty: false },
				{ id: 2, path: "/workspace/b.md", dirty: false },
				{ id: 3, path: "/workspace/c.md", dirty: false },
			],
			2,
		);

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		tabs[1].focus();

		fireEvent.keyDown(tabs[1], { key: "End" });
		expect(document.activeElement).toBe(tabs[2]);
		expect(onTabSelect).toHaveBeenCalledWith(3);

		fireEvent.keyDown(tabs[2], { key: "Home" });
		expect(document.activeElement).toBe(tabs[0]);
		expect(onTabSelect).toHaveBeenCalledWith(1);
	});

	describe("navigation buttons", () => {
		it("renders back and forward buttons", () => {
			render(<TabBar {...defaultProps} />);
			expect(screen.getByLabelText("戻る")).toBeInTheDocument();
			expect(screen.getByLabelText("進む")).toBeInTheDocument();
		});

		it("disables back button when canGoBack is false", () => {
			render(<TabBar {...defaultProps} canGoBack={false} canGoForward={true} />);
			expect(screen.getByLabelText("戻る")).toBeDisabled();
			expect(screen.getByLabelText("進む")).not.toBeDisabled();
		});

		it("disables forward button when canGoForward is false", () => {
			render(<TabBar {...defaultProps} canGoBack={true} canGoForward={false} />);
			expect(screen.getByLabelText("戻る")).not.toBeDisabled();
			expect(screen.getByLabelText("進む")).toBeDisabled();
		});

		it("calls onGoBack when back button is clicked", () => {
			render(<TabBar {...defaultProps} canGoBack={true} />);
			fireEvent.click(screen.getByLabelText("戻る"));
			expect(onGoBack).toHaveBeenCalledTimes(1);
		});

		it("calls onGoForward when forward button is clicked", () => {
			render(<TabBar {...defaultProps} canGoForward={true} />);
			fireEvent.click(screen.getByLabelText("進む"));
			expect(onGoForward).toHaveBeenCalledTimes(1);
		});
	});

	describe("pointer-based drag reorder", () => {
		it("calls onReorderTab when dragged rightward (right half of target)", () => {
			setTabs(
				[
					{ id: 1, path: "/workspace/a.md", dirty: false },
					{ id: 2, path: "/workspace/b.md", dirty: false },
					{ id: 3, path: "/workspace/c.md", dirty: false },
				],
				1,
			);

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			// Drag A (index 0) → drop on right half of C (index 2)
			// jsdom: getBoundingClientRect returns {left:0,right:0}, midX=0
			// clientX >= 0 → side="right"
			fireEvent.pointerDown(tabs[0], { clientX: 0, button: 0 });
			fireEvent(document, new PointerEvent("pointermove", { clientX: 100, bubbles: true }));
			fireEvent.pointerUp(tabs[2], { clientX: 10 });

			// side="right", fromIndex=0 < targetIndex=2 → toIndex=2
			// [A,B,C] → remove A → [B,C] → insert at 2 → [B,C,A]
			expect(onReorderTab).toHaveBeenCalledWith(0, 2);
		});

		it("inserts to right of target when dragging leftward", () => {
			setTabs(
				[
					{ id: 1, path: "/workspace/a.md", dirty: false },
					{ id: 2, path: "/workspace/b.md", dirty: false },
					{ id: 3, path: "/workspace/c.md", dirty: false },
				],
				3,
			);

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			// Drag C (index 2) → drop on right half of A (index 0)
			fireEvent.pointerDown(tabs[2], { clientX: 100, button: 0 });
			fireEvent(document, new PointerEvent("pointermove", { clientX: 0, bubbles: true }));
			fireEvent.pointerUp(tabs[0], { clientX: 10 });

			// side="right", fromIndex=2 > targetIndex=0 → toIndex=0+1=1
			// [A,B,C] → remove C → [A,B] → insert at 1 → [A,C,B]
			expect(onReorderTab).toHaveBeenCalledWith(2, 1);
		});

		it("can move tab to leftmost position by dropping on left half", () => {
			setTabs(
				[
					{ id: 1, path: "/workspace/a.md", dirty: false },
					{ id: 2, path: "/workspace/b.md", dirty: false },
					{ id: 3, path: "/workspace/c.md", dirty: false },
				],
				3,
			);

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			// Drag C (index 2) → drop on left half of A (index 0)
			// clientX < 0 → side="left" (jsdom midX=0)
			fireEvent.pointerDown(tabs[2], { clientX: 100, button: 0 });
			fireEvent(document, new PointerEvent("pointermove", { clientX: -10, bubbles: true }));
			fireEvent.pointerUp(tabs[0], { clientX: -10 });

			// side="left", fromIndex=2 > targetIndex=0 → toIndex=0
			// [A,B,C] → remove C → [A,B] → insert at 0 → [C,A,B]
			expect(onReorderTab).toHaveBeenCalledWith(2, 0);
		});

		it("does not call onReorderTab when released on same tab", () => {
			setTabs(
				[
					{ id: 1, path: "/workspace/a.md", dirty: false },
					{ id: 2, path: "/workspace/b.md", dirty: false },
				],
				1,
			);

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			fireEvent.pointerDown(tabs[0], { clientX: 0, button: 0 });
			fireEvent(document, new PointerEvent("pointermove", { clientX: 100, bubbles: true }));
			fireEvent.pointerUp(tabs[0]);

			expect(onReorderTab).not.toHaveBeenCalled();
		});

		it("does not trigger drag on small pointer movement (click)", () => {
			setTabs(
				[
					{ id: 1, path: "/workspace/a.md", dirty: false },
					{ id: 2, path: "/workspace/b.md", dirty: false },
				],
				1,
			);

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			// Small movement within threshold
			fireEvent.pointerDown(tabs[0], { clientX: 0, button: 0 });
			fireEvent(document, new PointerEvent("pointermove", { clientX: 3, bubbles: true }));
			fireEvent.pointerUp(tabs[1]);

			expect(onReorderTab).not.toHaveBeenCalled();
			// The click handler should still work
		});

		it("suppresses click after drag completes", () => {
			setTabs(
				[
					{ id: 1, path: "/workspace/a.md", dirty: false },
					{ id: 2, path: "/workspace/b.md", dirty: false },
					{ id: 3, path: "/workspace/c.md", dirty: false },
				],
				1,
			);

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			fireEvent.pointerDown(tabs[0], { clientX: 0, button: 0 });
			fireEvent(document, new PointerEvent("pointermove", { clientX: 100, bubbles: true }));
			fireEvent.pointerUp(tabs[2]);

			// Click fires after pointerUp (browser behavior) — should be suppressed
			fireEvent.click(tabs[2]);
			expect(onTabSelect).not.toHaveBeenCalled();
		});
	});
});
