import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDirectory } from "../../lib/commands";

vi.mock("../../lib/commands", () => ({
	listDirectory: vi.fn(),
}));

const { FileTree } = await import("./FileTree");

const mockedListDirectory = listDirectory as Mock;

const mockEntries = [
	{ name: "docs", path: "/workspace/docs", isDirectory: true },
	{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
	{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
];

describe("FileTree", () => {
	beforeEach(() => {
		mockedListDirectory.mockResolvedValue(mockEntries);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("loads and displays entries from workspace", async () => {
		await act(async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		});

		expect(mockedListDirectory).toHaveBeenCalledWith("/workspace");
		expect(screen.getByText("docs")).toBeInTheDocument();
		expect(screen.getByText("hello.md")).toBeInTheDocument();
		expect(screen.getByText("notes.md")).toBeInTheDocument();
	});

	it("calls onFileSelect when a file is clicked", async () => {
		const onFileSelect = vi.fn();
		await act(async () => {
			render(
				<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={onFileSelect} />,
			);
		});

		await userEvent.click(screen.getByText("hello.md"));
		expect(onFileSelect).toHaveBeenCalledWith("/workspace/hello.md");
	});

	it("highlights the selected file", async () => {
		await act(async () => {
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath="/workspace/hello.md"
					onFileSelect={() => {}}
				/>,
			);
		});

		const button = screen.getByText("hello.md").closest("button");
		expect(button?.className).toContain("bg-black/10");
	});

	it("expands a folder on click and loads children", async () => {
		const childEntries = [
			{ name: "readme.md", path: "/workspace/docs/readme.md", isDirectory: false },
		];
		mockedListDirectory.mockResolvedValueOnce(mockEntries).mockResolvedValueOnce(childEntries);

		await act(async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		});

		await act(async () => {
			await userEvent.click(screen.getByText("docs"));
		});

		expect(mockedListDirectory).toHaveBeenCalledWith("/workspace/docs");
		expect(screen.getByText("readme.md")).toBeInTheDocument();
	});

	it("shows empty folder message", async () => {
		mockedListDirectory.mockResolvedValue([]);

		await act(async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		});

		expect(screen.getByText("Empty folder")).toBeInTheDocument();
	});

	it("shows error message on failure", async () => {
		mockedListDirectory.mockRejectedValue(new Error("Permission denied"));

		await act(async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		});

		expect(screen.getByText("Failed to load folder")).toBeInTheDocument();
	});
});
