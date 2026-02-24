import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDirectory,
	createFile,
	deleteEntry,
	listDirectory,
	renameEntry,
} from "../../lib/commands";

vi.mock("../../lib/commands", () => ({
	listDirectory: vi.fn(),
	createFile: vi.fn(),
	createDirectory: vi.fn(),
	renameEntry: vi.fn(),
	deleteEntry: vi.fn(),
}));

const { FileTree } = await import("./FileTree");

const mockedListDirectory = listDirectory as Mock;
const mockedCreateFile = createFile as Mock;
const mockedCreateDirectory = createDirectory as Mock;
const mockedRenameEntry = renameEntry as Mock;
const mockedDeleteEntry = deleteEntry as Mock;

const mockEntries = [
	{ name: "docs", path: "/workspace/docs", isDirectory: true },
	{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
	{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
];

describe("FileTree", () => {
	beforeEach(() => {
		mockedListDirectory.mockResolvedValue(mockEntries);
		mockedCreateFile.mockResolvedValue(undefined);
		mockedCreateDirectory.mockResolvedValue(undefined);
		mockedRenameEntry.mockResolvedValue(undefined);
		mockedDeleteEntry.mockResolvedValue(undefined);
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

	it("shows loading state before entries are fetched", () => {
		mockedListDirectory.mockReturnValue(new Promise(() => {}));

		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);

		expect(screen.getByText("Loading...")).toBeInTheDocument();
		expect(screen.queryByText("Empty folder")).not.toBeInTheDocument();
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

		expect(screen.getByText("フォルダの読み込みに失敗しました")).toBeInTheDocument();
	});

	it("creates a file via context menu and calls onFileSelect", async () => {
		const onFileSelect = vi.fn();
		await act(async () => {
			render(
				<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={onFileSelect} />,
			);
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(fileButton);
		});

		await userEvent.click(screen.getByText("New File"));

		const input = screen.getByRole("textbox");
		await userEvent.type(input, "new.md");
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});

		expect(mockedCreateFile).toHaveBeenCalledWith("/workspace/new.md");
		expect(onFileSelect).toHaveBeenCalledWith("/workspace/new.md");
	});

	it("creates a folder via context menu", async () => {
		mockedListDirectory.mockResolvedValueOnce(mockEntries).mockResolvedValueOnce([]);

		await act(async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		});

		const folderButton = screen.getByText("docs").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(folderButton);
		});

		await act(async () => {
			await userEvent.click(screen.getByText("New Folder"));
		});

		const input = screen.getByRole("textbox");
		await userEvent.type(input, "subfolder");
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});

		expect(mockedCreateDirectory).toHaveBeenCalledWith("/workspace/docs/subfolder");
	});

	it("renames a file via context menu and calls onFileRenamed", async () => {
		const onFileRenamed = vi.fn();
		await act(async () => {
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath={null}
					onFileSelect={() => {}}
					onFileRenamed={onFileRenamed}
				/>,
			);
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(fileButton);
		});

		await userEvent.click(screen.getByText("Rename"));

		const input = screen.getByRole("textbox");
		await userEvent.clear(input);
		await userEvent.type(input, "renamed.md");
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});

		expect(mockedRenameEntry).toHaveBeenCalledWith("/workspace/hello.md", "/workspace/renamed.md");
		expect(onFileRenamed).toHaveBeenCalledWith(
			"/workspace/hello.md",
			"/workspace/renamed.md",
			false,
		);
	});

	it("shows 'open in new tab' in context menu for files", async () => {
		const onFileOpenNewTab = vi.fn();
		await act(async () => {
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath={null}
					onFileSelect={() => {}}
					onFileOpenNewTab={onFileOpenNewTab}
				/>,
			);
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(fileButton);
		});

		await userEvent.click(screen.getByText("新しいタブで開く"));
		expect(onFileOpenNewTab).toHaveBeenCalledWith("/workspace/hello.md");
	});

	it("does not show 'open in new tab' for folders", async () => {
		const onFileOpenNewTab = vi.fn();
		await act(async () => {
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath={null}
					onFileSelect={() => {}}
					onFileOpenNewTab={onFileOpenNewTab}
				/>,
			);
		});

		const folderButton = screen.getByText("docs").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(folderButton);
		});

		expect(screen.queryByText("新しいタブで開く")).not.toBeInTheDocument();
	});

	it("calls onFileOpenNewTab on Cmd+Click", async () => {
		const onFileSelect = vi.fn();
		const onFileOpenNewTab = vi.fn();
		await act(async () => {
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath={null}
					onFileSelect={onFileSelect}
					onFileOpenNewTab={onFileOpenNewTab}
				/>,
			);
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		fireEvent.click(fileButton, { metaKey: true });
		expect(onFileOpenNewTab).toHaveBeenCalledWith("/workspace/hello.md");
		expect(onFileSelect).not.toHaveBeenCalled();
	});

	it("calls onFileSelect on normal click (no modifier)", async () => {
		const onFileSelect = vi.fn();
		const onFileOpenNewTab = vi.fn();
		await act(async () => {
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath={null}
					onFileSelect={onFileSelect}
					onFileOpenNewTab={onFileOpenNewTab}
				/>,
			);
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		fireEvent.click(fileButton);
		expect(onFileSelect).toHaveBeenCalledWith("/workspace/hello.md");
		expect(onFileOpenNewTab).not.toHaveBeenCalled();
	});

	it("deletes a file via context menu and calls onFileDeleted", async () => {
		const onFileDeleted = vi.fn();
		await act(async () => {
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath={null}
					onFileSelect={() => {}}
					onFileDeleted={onFileDeleted}
				/>,
			);
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(fileButton);
		});

		await userEvent.click(screen.getByText("Delete"));

		expect(screen.getByText(/を削除しますか？ゴミ箱に移動されます/)).toBeInTheDocument();

		await act(async () => {
			await userEvent.click(screen.getByText("削除", { selector: "button" }));
		});

		expect(mockedDeleteEntry).toHaveBeenCalledWith("/workspace/hello.md");
		expect(onFileDeleted).toHaveBeenCalledWith("/workspace/hello.md", false);
	});
});
