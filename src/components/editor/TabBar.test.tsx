import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../stores/workspace";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
	const onCloseTab = vi.fn();

	beforeEach(() => {
		onCloseTab.mockClear();
		useWorkspaceStore.setState({
			workspacePath: "/workspace",
			tabs: [],
			activeTabPath: null,
		});
	});

	it("renders tablist with aria-label", () => {
		render(<TabBar onCloseTab={onCloseTab} />);
		expect(screen.getByRole("tablist", { name: "Editor tabs" })).toBeInTheDocument();
	});

	it("renders empty when no tabs", () => {
		render(<TabBar onCloseTab={onCloseTab} />);
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

		render(<TabBar onCloseTab={onCloseTab} />);
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

		render(<TabBar onCloseTab={onCloseTab} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");
	});

	it("calls setActiveTab on tab click", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar onCloseTab={onCloseTab} />);
		fireEvent.click(screen.getByText("b.md"));

		expect(useWorkspaceStore.getState().activeTabPath).toBe("/workspace/b.md");
	});

	it("calls onCloseTab when close button is clicked", () => {
		useWorkspaceStore.setState({
			tabs: [{ path: "/workspace/a.md", dirty: false }],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar onCloseTab={onCloseTab} />);
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

		const { container } = render(<TabBar onCloseTab={onCloseTab} />);
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

		render(<TabBar onCloseTab={onCloseTab} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("aria-label", "a.md, unsaved changes");
		expect(tabs[1]).not.toHaveAttribute("aria-label");
	});

	it("calls onCloseTab when Delete key is pressed on focused tab", () => {
		useWorkspaceStore.setState({
			tabs: [{ path: "/workspace/a.md", dirty: false }],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar onCloseTab={onCloseTab} />);
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

		render(<TabBar onCloseTab={onCloseTab} />);
		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveAttribute("tabindex", "-1");
		expect(tabs[1]).toHaveAttribute("tabindex", "0");
	});

	it("moves focus with arrow keys", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
				{ path: "/workspace/c.md", dirty: false },
			],
			activeTabPath: "/workspace/a.md",
		});

		render(<TabBar onCloseTab={onCloseTab} />);
		const tabs = screen.getAllByRole("tab");
		tabs[0].focus();

		fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[1]);

		fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[2]);

		// Wraps around
		fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
		expect(document.activeElement).toBe(tabs[0]);

		fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
		expect(document.activeElement).toBe(tabs[2]);
	});

	it("moves focus with Home/End keys", () => {
		useWorkspaceStore.setState({
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: false },
				{ path: "/workspace/c.md", dirty: false },
			],
			activeTabPath: "/workspace/b.md",
		});

		render(<TabBar onCloseTab={onCloseTab} />);
		const tabs = screen.getAllByRole("tab");
		tabs[1].focus();

		fireEvent.keyDown(tabs[1], { key: "End" });
		expect(document.activeElement).toBe(tabs[2]);

		fireEvent.keyDown(tabs[2], { key: "Home" });
		expect(document.activeElement).toBe(tabs[0]);
	});
});
