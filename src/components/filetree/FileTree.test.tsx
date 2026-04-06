import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	createDirectory,
	createFile,
	deleteEntry,
	listDirectory,
	renameEntry,
} from "../../lib/commands";
import { useDragStore } from "../../stores/drag";

vi.mock("../../lib/commands", () => ({
	listDirectory: vi.fn(),
	createFile: vi.fn(),
	createDirectory: vi.fn(),
	renameEntry: vi.fn(),
	deleteEntry: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn().mockResolvedValue(undefined),
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
		vi.clearAllMocks();
		useDragStore.getState().reset();
	});

	it("loads and displays entries from workspace", async () => {
		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		await waitFor(() => {
			expect(screen.getByText("docs")).toBeInTheDocument();
		});

		expect(mockedListDirectory).toHaveBeenCalledWith("/workspace");
		expect(screen.getByText("hello.md")).toBeInTheDocument();
		expect(screen.getByText("notes.md")).toBeInTheDocument();
	});

	it("calls onFileSelect when a file is clicked", async () => {
		const onFileSelect = vi.fn();
		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={onFileSelect} />);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
		});

		await userEvent.click(screen.getByText("hello.md"));
		expect(onFileSelect).toHaveBeenCalledWith("/workspace/hello.md");
	});

	it("highlights the selected file", async () => {
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath="/workspace/hello.md"
				onFileSelect={() => {}}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
		});

		const button = screen.getByText("hello.md").closest("button");
		expect(button?.className).toContain("bg-black/10");
	});

	it("expands a folder on click and loads children", async () => {
		const childEntries = [
			{ name: "readme.md", path: "/workspace/docs/readme.md", isDirectory: false },
		];
		mockedListDirectory.mockResolvedValueOnce(mockEntries).mockResolvedValueOnce(childEntries);

		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		await waitFor(() => {
			expect(screen.getByText("docs")).toBeInTheDocument();
		});

		await userEvent.click(screen.getByText("docs"));
		await waitFor(() => {
			expect(screen.getByText("readme.md")).toBeInTheDocument();
		});

		expect(mockedListDirectory).toHaveBeenCalledWith("/workspace/docs");
	});

	it("shows loading state before entries are fetched", () => {
		mockedListDirectory.mockReturnValue(new Promise(() => {}));

		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);

		expect(screen.getByText("Loading...")).toBeInTheDocument();
		expect(screen.queryByText("Empty folder")).not.toBeInTheDocument();
	});

	it("shows empty folder message", async () => {
		mockedListDirectory.mockResolvedValue([]);

		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		await waitFor(() => {
			expect(screen.getByText("Empty folder")).toBeInTheDocument();
		});
	});

	it("shows error message on failure", async () => {
		mockedListDirectory.mockRejectedValue(new Error("Permission denied"));

		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		await waitFor(() => {
			expect(screen.getByText("フォルダの読み込みに失敗しました")).toBeInTheDocument();
		});
	});

	it("creates a file via context menu and calls onFileSelect", async () => {
		const onFileSelect = vi.fn();
		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={onFileSelect} />);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
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

		await waitFor(() => {
			expect(mockedCreateFile).toHaveBeenCalledWith("/workspace/new.md");
		});
		expect(onFileSelect).toHaveBeenCalledWith("/workspace/new.md");
	});

	it("creates a folder via context menu", async () => {
		mockedListDirectory.mockResolvedValueOnce(mockEntries).mockResolvedValueOnce([]);

		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		await waitFor(() => {
			expect(screen.getByText("docs")).toBeInTheDocument();
		});

		const folderButton = screen.getByText("docs").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(folderButton);
		});

		await userEvent.click(screen.getByText("New Folder"));

		const input = screen.getByRole("textbox");
		await userEvent.type(input, "subfolder");
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});

		await waitFor(() => {
			expect(mockedCreateDirectory).toHaveBeenCalledWith("/workspace/docs/subfolder");
		});
	});

	it("renames a file via context menu and calls onFileRenamed", async () => {
		const onFileRenamed = vi.fn();
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath={null}
				onFileSelect={() => {}}
				onFileRenamed={onFileRenamed}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
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

		await waitFor(() => {
			expect(mockedRenameEntry).toHaveBeenCalledWith(
				"/workspace/hello.md",
				"/workspace/renamed.md",
			);
		});
		expect(onFileRenamed).toHaveBeenCalledWith(
			"/workspace/hello.md",
			"/workspace/renamed.md",
			false,
		);
	});

	it("does not confirm rename when Enter is pressed during IME composition (keyCode 229)", async () => {
		render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(fileButton);
		});

		await userEvent.click(screen.getByText("Rename"));

		const input = screen.getByRole("textbox");
		await userEvent.clear(input);
		await userEvent.type(input, "test");

		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
		});

		expect(mockedRenameEntry).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("confirms rename when Enter is pressed after IME composition ends (keyCode 13)", async () => {
		const onFileRenamed = vi.fn();
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath={null}
				onFileSelect={() => {}}
				onFileRenamed={onFileRenamed}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(fileButton);
		});

		await userEvent.click(screen.getByText("Rename"));

		const input = screen.getByRole("textbox");
		await userEvent.clear(input);
		await userEvent.type(input, "メモ.md");

		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
		});
		expect(mockedRenameEntry).not.toHaveBeenCalled();

		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
		});

		await waitFor(() => {
			expect(mockedRenameEntry).toHaveBeenCalledWith("/workspace/hello.md", "/workspace/メモ.md");
		});
	});

	it("shows 'open in new tab' in context menu for files", async () => {
		const onFileOpenNewTab = vi.fn();
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath={null}
				onFileSelect={() => {}}
				onFileOpenNewTab={onFileOpenNewTab}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
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
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath={null}
				onFileSelect={() => {}}
				onFileOpenNewTab={onFileOpenNewTab}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("docs")).toBeInTheDocument();
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
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath={null}
				onFileSelect={onFileSelect}
				onFileOpenNewTab={onFileOpenNewTab}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		fireEvent.click(fileButton, { metaKey: true });
		expect(onFileOpenNewTab).toHaveBeenCalledWith("/workspace/hello.md");
		expect(onFileSelect).not.toHaveBeenCalled();
	});

	it("calls onFileSelect on normal click (no modifier)", async () => {
		const onFileSelect = vi.fn();
		const onFileOpenNewTab = vi.fn();
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath={null}
				onFileSelect={onFileSelect}
				onFileOpenNewTab={onFileOpenNewTab}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		fireEvent.click(fileButton);
		expect(onFileSelect).toHaveBeenCalledWith("/workspace/hello.md");
		expect(onFileOpenNewTab).not.toHaveBeenCalled();
	});

	it("deletes a file via context menu and calls onFileDeleted", async () => {
		const onFileDeleted = vi.fn();
		render(
			<FileTree
				workspacePath="/workspace"
				selectedPath={null}
				onFileSelect={() => {}}
				onFileDeleted={onFileDeleted}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("hello.md")).toBeInTheDocument();
		});

		const fileButton = screen.getByText("hello.md").closest("button") as HTMLElement;
		await act(async () => {
			fireEvent.contextMenu(fileButton);
		});

		await userEvent.click(screen.getByText("Delete"));

		expect(screen.getByText(/を削除しますか？ゴミ箱に移動されます/)).toBeInTheDocument();

		await userEvent.click(screen.getByText("削除", { selector: "button" }));

		await waitFor(() => {
			expect(mockedDeleteEntry).toHaveBeenCalledWith("/workspace/hello.md");
		});
		expect(onFileDeleted).toHaveBeenCalledWith("/workspace/hello.md", false);
	});

	describe("Drag and Drop", () => {
		function mockRect(el: Element, x: number, y: number, w: number, h: number) {
			vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
				x,
				y,
				top: y,
				left: x,
				width: w,
				height: h,
				bottom: y + h,
				right: x + w,
				toJSON: () => {},
			} as DOMRect);
		}

		function dispatchPointerMove(clientX: number, clientY: number) {
			document.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY, bubbles: true }));
		}

		function dispatchPointerUp(clientX: number, clientY: number) {
			document.dispatchEvent(new PointerEvent("pointerup", { clientX, clientY, bubbles: true }));
		}

		it("moves a file to a folder via drag and drop", async () => {
			const onFileRenamed = vi.fn();
			render(
				<FileTree
					workspacePath="/workspace"
					selectedPath={null}
					onFileSelect={() => {}}
					onFileRenamed={onFileRenamed}
				/>,
			);
			await waitFor(() => {
				expect(screen.getByText("hello.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const folderBtn = screen.getByLabelText("docs folder");
			const fileBtn = screen.getByLabelText("hello.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(folderBtn, 0, 0, 300, 30);
			mockRect(fileBtn, 0, 30, 300, 30);

			fireEvent.pointerDown(fileBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(150, 15);
			});
			act(() => {
				dispatchPointerUp(150, 15);
			});

			await waitFor(() => {
				expect(mockedRenameEntry).toHaveBeenCalledWith(
					"/workspace/hello.md",
					"/workspace/docs/hello.md",
				);
			});
			expect(onFileRenamed).toHaveBeenCalledWith(
				"/workspace/hello.md",
				"/workspace/docs/hello.md",
				false,
			);
		});

		it("does not trigger renameEntry when dropping on a non-directory", async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("hello.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const fileBtn = screen.getByLabelText("hello.md file");
			const otherFileBtn = screen.getByLabelText("notes.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(fileBtn, 0, 30, 300, 30);
			mockRect(otherFileBtn, 0, 60, 300, 30);

			fireEvent.pointerDown(fileBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(150, 75);
			});
			act(() => {
				dispatchPointerUp(150, 75);
			});

			expect(mockedRenameEntry).not.toHaveBeenCalled();
		});

		it("does not trigger renameEntry when dropping to the same parent", async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("hello.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const fileBtn = screen.getByLabelText("hello.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(fileBtn, 0, 30, 300, 30);

			// Drag to empty area (y=200) → workspace root = same parent for hello.md
			fireEvent.pointerDown(fileBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(150, 200);
			});
			act(() => {
				dispatchPointerUp(150, 200);
			});

			expect(mockedRenameEntry).not.toHaveBeenCalled();
		});

		it("does not move when dropped back on the original position", async () => {
			const childEntries = [
				{ name: "readme.md", path: "/workspace/docs/readme.md", isDirectory: false },
			];
			mockedListDirectory.mockResolvedValueOnce(mockEntries).mockResolvedValueOnce(childEntries);

			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("docs")).toBeInTheDocument();
			});

			// Expand docs to reveal readme.md
			await userEvent.click(screen.getByText("docs"));
			await waitFor(() => {
				expect(screen.getByText("readme.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const readmeBtn = screen.getByLabelText("readme.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(readmeBtn, 0, 60, 300, 30);

			// Drag readme.md and drop it back on itself
			fireEvent.pointerDown(readmeBtn, { button: 0, clientX: 150, clientY: 75 });
			act(() => {
				dispatchPointerMove(150, 70);
			});
			act(() => {
				dispatchPointerUp(150, 70);
			});

			expect(mockedRenameEntry).not.toHaveBeenCalled();
		});

		it("blocks circular move (folder to its own descendant)", async () => {
			const childEntries = [
				{ name: "subfolder", path: "/workspace/docs/subfolder", isDirectory: true },
			];
			mockedListDirectory.mockResolvedValueOnce(mockEntries).mockResolvedValueOnce(childEntries);

			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("docs")).toBeInTheDocument();
			});

			// Expand docs to reveal subfolder
			await userEvent.click(screen.getByText("docs"));
			await waitFor(() => {
				expect(screen.getByText("subfolder")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const docsBtn = screen.getByLabelText("docs folder");
			const subfolderBtn = screen.getByLabelText("subfolder folder");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(docsBtn, 0, 0, 300, 30);
			mockRect(subfolderBtn, 0, 30, 300, 30);

			fireEvent.pointerDown(docsBtn, { button: 0, clientX: 150, clientY: 15 });
			act(() => {
				dispatchPointerMove(150, 45);
			});
			act(() => {
				dispatchPointerUp(150, 45);
			});

			expect(mockedRenameEntry).not.toHaveBeenCalled();
		});

		it("moves a file to workspace root from a subfolder", async () => {
			const childEntries = [
				{ name: "readme.md", path: "/workspace/docs/readme.md", isDirectory: false },
			];
			mockedListDirectory.mockResolvedValueOnce(mockEntries).mockResolvedValueOnce(childEntries);

			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("docs")).toBeInTheDocument();
			});

			// Expand docs to reveal readme.md
			await userEvent.click(screen.getByText("docs"));
			await waitFor(() => {
				expect(screen.getByText("readme.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const readmeBtn = screen.getByLabelText("readme.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(readmeBtn, 0, 30, 300, 30);

			// Drag to empty area (y=200) → workspace root
			fireEvent.pointerDown(readmeBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(150, 200);
			});
			act(() => {
				dispatchPointerUp(150, 200);
			});

			await waitFor(() => {
				expect(mockedRenameEntry).toHaveBeenCalledWith(
					"/workspace/docs/readme.md",
					"/workspace/readme.md",
				);
			});
		});

		it("shows error toast on rename failure", async () => {
			mockedRenameEntry.mockRejectedValueOnce("Target already exists: /workspace/docs/hello.md");

			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("hello.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const folderBtn = screen.getByLabelText("docs folder");
			const fileBtn = screen.getByLabelText("hello.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(folderBtn, 0, 0, 300, 30);
			mockRect(fileBtn, 0, 30, 300, 30);

			fireEvent.pointerDown(fileBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(150, 15);
			});
			act(() => {
				dispatchPointerUp(150, 15);
			});

			await waitFor(() => {
				expect(mockedRenameEntry).toHaveBeenCalledWith(
					"/workspace/hello.md",
					"/workspace/docs/hello.md",
				);
			});
		});

		it("shows visual feedback during drag", async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("hello.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const folderBtn = screen.getByLabelText("docs folder");
			const fileBtn = screen.getByLabelText("hello.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(folderBtn, 0, 0, 300, 30);
			mockRect(fileBtn, 0, 30, 300, 30);

			fireEvent.pointerDown(fileBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(150, 15);
			});

			// Source should have opacity-40
			expect(fileBtn.className).toContain("opacity-40");
			// Target folder should have highlight
			expect(folderBtn.className).toContain("bg-black/10");

			// Clean up
			act(() => {
				dispatchPointerUp(150, 15);
			});
		});

		it("does not start drag below threshold", async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("hello.md")).toBeInTheDocument();
			});

			const fileBtn = screen.getByLabelText("hello.md file");

			fireEvent.pointerDown(fileBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(152, 46);
			});

			// Should NOT show visual feedback
			expect(fileBtn.className).not.toContain("opacity-40");

			act(() => {
				dispatchPointerUp(152, 46);
			});

			expect(mockedRenameEntry).not.toHaveBeenCalled();
		});

		it("highlights workspace root when dragging to empty area", async () => {
			render(<FileTree workspacePath="/workspace" selectedPath={null} onFileSelect={() => {}} />);
			await waitFor(() => {
				expect(screen.getByText("hello.md")).toBeInTheDocument();
			});

			const rootUl = document.querySelector("ul") as HTMLUListElement;
			const fileBtn = screen.getByLabelText("hello.md file");

			mockRect(rootUl, 0, 0, 300, 500);
			mockRect(fileBtn, 0, 30, 300, 30);

			fireEvent.pointerDown(fileBtn, { button: 0, clientX: 150, clientY: 45 });
			act(() => {
				dispatchPointerMove(150, 200);
			});

			// Root <ul> should have highlight
			expect(rootUl.className).toContain("bg-black/5");

			act(() => {
				dispatchPointerUp(150, 200);
			});
		});
	});
});
