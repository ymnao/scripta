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
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar {...defaultProps} />);
		expect(screen.getByText("a.md")).toBeInTheDocument();
		expect(screen.getByText("b.md")).toBeInTheDocument();
	});

	it("marks active tab with aria-selected", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");
	});

	it("calls onTabSelect on tab click", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar {...defaultProps} />);
		fireEvent.click(screen.getByText("b.md"));

		expect(onTabSelect).toHaveBeenCalledWith("/workspace/b.md");
	});

	it("calls onCloseTab when close button is clicked", () => {
		useWorkspaceStore.setState({
			tabs: [{ path: "/workspace/a.md", dirty: false }],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar {...defaultProps} />);
		fireEvent.click(screen.getByLabelText("Close a.md"));

		expect(onCloseTab).toHaveBeenCalledWith("/workspace/a.md");
	});

	it("shows dirty indicator for dirty tabs", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: true },
				{ path: "/workspace/b.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		const { container } = render(<TabBar {...defaultProps} />);
		const dots = container.querySelectorAll(".rounded-full");
		expect(dots).toHaveLength(1);
	});

	it("announces unsaved changes via aria-label on dirty tab", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: true },
				{ path: "/workspace/b.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("aria-label", "a.md, unsaved changes");
		expect(tabs[1]).not.toHaveAttribute("aria-label");
	});

	it("calls onCloseTab when Delete key is pressed on focused tab", () => {
		useWorkspaceStore.setState({
			tabs: [{ path: "/workspace/a.md", dirty: false }],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar {...defaultProps} />);
		const tab = screen.getByRole("tab");
		fireEvent.keyDown(tab, { key: "Delete" });

		expect(onCloseTab).toHaveBeenCalledWith("/workspace/a.md");
	});

	it("uses roving tabindex (active=0, others=-1)", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
			],
			activeTabPath: "/workspace/b.md",
		});

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("tabindex", "-1");
		expect(tabs[1]).toHaveAttribute("tabindex", "0");
	});

	it("calls onTabSelect with arrow keys", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
				{ path: "/workspace/c.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		tabs[0].focus();

		fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[1]);
		expect(onTabSelect).toHaveBeenCalledWith("/workspace/b.md");

		fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[2]);
		expect(onTabSelect).toHaveBeenCalledWith("/workspace/c.md");

		// Wraps around
		fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[0]);
		expect(onTabSelect).toHaveBeenCalledWith("/workspace/a.md");

		fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
		expect(document.activeElement).toBe(tabs[2]);
		expect(onTabSelect).toHaveBeenCalledWith("/workspace/c.md");
	});

	it("calls onTabSelect with Home/End keys", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
				{ path: "/workspace/c.md", dirty: false },
			],
			activeTabPath: "/workspace/b.md",
		});

		render(<TabBar {...defaultProps} />);
		const tabs = screen.getAllByRole("tab");
		tabs[1].focus();

		fireEvent.keyDown(tabs[1], { key: "End" });
		expect(document.activeElement).toBe(tabs[2]);
		expect(onTabSelect).toHaveBeenCalledWith("/workspace/c.md");

		fireEvent.keyDown(tabs[2], { key: "Home" });
		expect(document.activeElement).toBe(tabs[0]);
		expect(onTabSelect).toHaveBeenCalledWith("/workspace/a.md");
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

	describe("drag and drop reorder", () => {
		it("makes tabs draggable", () => {
			useWorkspaceStore.setState({
				tabs: [{ path: "/workspace/a.md", dirty: false }],
				activeTabPath: "/workspace/a.md",
			});

			render(<TabBar {...defaultProps} />);
			const tab = screen.getByRole("tab");
			expect(tab).toHaveAttribute("draggable", "true");
		});

		it("calls onReorderTab on drop", () => {
			useWorkspaceStore.setState({
				tabs: [
					{ path: "/workspace/a.md", dirty: false },
					{ path: "/workspace/b.md", dirty: false },
					{ path: "/workspace/c.md", dirty: false },
				],
				activeTabPath: "/workspace/a.md",
			});

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			fireEvent.dragStart(tabs[0], {
				dataTransfer: { effectAllowed: "move", setData: vi.fn() },
			});
			fireEvent.dragOver(tabs[2], {
				dataTransfer: { dropEffect: "move" },
			});
			fireEvent.drop(tabs[2], {
				dataTransfer: {},
			});

			expect(onReorderTab).toHaveBeenCalledWith(0, 2);
		});

		it("does not call onReorderTab when dropping on same position", () => {
			useWorkspaceStore.setState({
				tabs: [
					{ path: "/workspace/a.md", dirty: false },
					{ path: "/workspace/b.md", dirty: false },
				],
				activeTabPath: "/workspace/a.md",
			});

			render(<TabBar {...defaultProps} />);
			const tabs = screen.getAllByRole("tab");

			fireEvent.dragStart(tabs[0], {
				dataTransfer: { effectAllowed: "move", setData: vi.fn() },
			});
			fireEvent.drop(tabs[0], {
				dataTransfer: {},
			});

			expect(onReorderTab).not.toHaveBeenCalled();
		});
	});
});
