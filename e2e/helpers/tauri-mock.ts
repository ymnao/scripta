import type { Page } from "@playwright/test";
import type { FileEntry, TauriMockStore } from "../mocks/types";

export interface MockFileSystem {
	files: Record<string, string>;
	directories: Record<string, FileEntry[]>;
}

type WindowWithMock = Window & { __TAURI_MOCK__?: TauriMockStore };
type WindowWithEvent = Window & {
	__TAURI_EVENT__?: { emit: (event: string, payload: unknown) => void };
};

export class TauriMock {
	private page: Page;
	constructor(page: Page) {
		this.page = page;
	}

	async setup(
		fs: MockFileSystem,
		dialogResult: string | null = null,
		storeValues?: Record<string, unknown>,
		saveDialogResult?: string | null,
	): Promise<void> {
		if (storeValues) {
			const storeJson = JSON.stringify(storeValues);
			await this.page.addInitScript((data: string) => {
				(window as unknown as Record<string, unknown>).__STORE_INIT__ = JSON.parse(data);
			}, storeJson);
		}

		const filesJson = JSON.stringify(fs.files);
		const directoriesJson = JSON.stringify(fs.directories);

		await this.page.addInitScript(
			({
				files,
				directories,
				dialog,
				saveDialog,
			}: {
				files: string;
				directories: string;
				dialog: string | null;
				saveDialog: string | null;
			}) => {
				const parsedFiles: Record<string, string> = JSON.parse(files);
				const parsedDirs: Record<
					string,
					Array<{ name: string; path: string; isDirectory: boolean }>
				> = JSON.parse(directories);

				const store: TauriMockStore = {
					handlers: {},
					calls: {},
					dialogResult: dialog,
					saveDialogResult: saveDialog,
				};
				(window as unknown as Record<string, unknown>).__TAURI_MOCK__ = store;

				store.handlers.read_file = (args: Record<string, unknown>) => {
					const path = args.path as string;
					if (path in parsedFiles) {
						return parsedFiles[path];
					}
					throw new Error(`File not found: ${path}`);
				};

				store.handlers.write_file = (args: Record<string, unknown>) => {
					const path = args.path as string;
					const content = args.content as string;
					parsedFiles[path] = content;
				};

				store.handlers.list_directory = (args: Record<string, unknown>) => {
					const path = args.path as string;
					if (path in parsedDirs) {
						return parsedDirs[path];
					}
					throw new Error(`Directory not found: ${path}`);
				};

				const collectMdFiles = (dirPath: string): string[] => {
					const results: string[] = [];
					const entries = parsedDirs[dirPath] ?? [];
					for (const entry of entries) {
						if (entry.isDirectory) {
							results.push(...collectMdFiles(entry.path));
						} else if (entry.name.endsWith(".md")) {
							results.push(entry.path);
						}
					}
					return results;
				};

				store.handlers.search_files = (args: Record<string, unknown>) => {
					const workspacePath = args.workspacePath as string;
					const rawQuery = args.query as string;
					const caseSensitive = (args.caseSensitive as boolean) ?? false;
					const query = caseSensitive ? rawQuery : rawQuery.toLowerCase();
					if (!query) return [];
					const mdFiles = collectMdFiles(workspacePath);
					const results: Array<{
						filePath: string;
						lineNumber: number;
						lineContent: string;
						matchStart: number;
						matchEnd: number;
					}> = [];
					for (const filePath of mdFiles) {
						const content = parsedFiles[filePath];
						if (!content) continue;
						const lines = content.split("\n");
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i];
							const searchLine = caseSensitive ? line : line.toLowerCase();
							let pos = 0;
							while (true) {
								const idx = searchLine.indexOf(query, pos);
								if (idx === -1) break;
								results.push({
									filePath,
									lineNumber: i + 1,
									lineContent: line,
									matchStart: idx,
									matchEnd: idx + query.length,
								});
								pos = idx + query.length;
							}
						}
					}
					return results;
				};

				store._files = parsedFiles;
				store._directories = parsedDirs;

				store.handlers.create_file = (args: Record<string, unknown>) => {
					const path = args.path as string;
					if (path in parsedFiles) {
						throw new Error(`Already exists: ${path}`);
					}
					parsedFiles[path] = "";
					// Add to parent directory listing
					const parts = path.split("/");
					const name = parts[parts.length - 1];
					const parentPath = parts.slice(0, -1).join("/");
					if (parentPath in parsedDirs) {
						parsedDirs[parentPath].push({
							name,
							path,
							isDirectory: false,
						});
					}
				};

				store.handlers.show_in_folder = () => {
					// no-op: just record the call
					return undefined;
				};

				store.handlers.start_watcher = () => {
					// no-op: just record the call
					return undefined;
				};

				store.handlers.stop_watcher = () => {
					// no-op: just record the call
					return undefined;
				};

				store.handlers.search_filenames = (args: Record<string, unknown>) => {
					const workspacePath = args.workspacePath as string;
					const query = (args.query as string).toLowerCase();
					const mdFiles = collectMdFiles(workspacePath);
					if (!query) return mdFiles;
					return mdFiles.filter((filePath) => {
						const lower = filePath.toLowerCase();
						let ti = 0;
						for (const ch of query) {
							const found = lower.indexOf(ch, ti);
							if (found === -1) return false;
							ti = found + 1;
						}
						return true;
					});
				};
			},
			{
				files: filesJson,
				directories: directoriesJson,
				dialog: dialogResult,
				saveDialog: saveDialogResult ?? null,
			},
		);
	}

	async getCalls(cmd: string): Promise<Array<Record<string, unknown>>> {
		return this.page.evaluate((c: string) => {
			return (window as unknown as WindowWithMock).__TAURI_MOCK__?.calls[c] ?? [];
		}, cmd);
	}

	async setFileContent(path: string, content: string): Promise<void> {
		await this.page.evaluate(
			({ path, content }: { path: string; content: string }) => {
				const handler = (window as unknown as WindowWithMock).__TAURI_MOCK__?.handlers.write_file;
				handler?.({ path, content });
			},
			{ path, content },
		);
	}

	async simulateFileCreate(
		filePath: string,
		content: string,
		parentDir: string,
		fileName: string,
	): Promise<void> {
		await this.page.evaluate(
			({
				filePath,
				content,
				parentDir,
				fileName,
			}: {
				filePath: string;
				content: string;
				parentDir: string;
				fileName: string;
			}) => {
				const store = (window as unknown as WindowWithMock).__TAURI_MOCK__;
				if (store?._files) store._files[filePath] = content;
				if (store?._directories?.[parentDir]) {
					store._directories[parentDir].push({
						name: fileName,
						path: filePath,
						isDirectory: false,
					});
				}
				const eventStore = (window as unknown as WindowWithEvent).__TAURI_EVENT__;
				eventStore?.emit("fs-change", [{ kind: "create", path: filePath }]);
			},
			{ filePath, content, parentDir, fileName },
		);
	}

	async simulateFileModify(filePath: string, newContent: string): Promise<void> {
		await this.page.evaluate(
			({ filePath, newContent }: { filePath: string; newContent: string }) => {
				const store = (window as unknown as WindowWithMock).__TAURI_MOCK__;
				if (store?._files) store._files[filePath] = newContent;
				const eventStore = (window as unknown as WindowWithEvent).__TAURI_EVENT__;
				eventStore?.emit("fs-change", [{ kind: "modify", path: filePath }]);
			},
			{ filePath, newContent },
		);
	}

	async simulateFileDelete(filePath: string, parentDir: string, fileName: string): Promise<void> {
		await this.page.evaluate(
			({
				filePath,
				parentDir,
				fileName,
			}: { filePath: string; parentDir: string; fileName: string }) => {
				const store = (window as unknown as WindowWithMock).__TAURI_MOCK__;
				if (store?._files) delete store._files[filePath];
				if (store?._directories?.[parentDir]) {
					store._directories[parentDir] = store._directories[parentDir].filter(
						(e) => e.name !== fileName,
					);
				}
				const eventStore = (window as unknown as WindowWithEvent).__TAURI_EVENT__;
				eventStore?.emit("fs-change", [{ kind: "delete", path: filePath }]);
			},
			{ filePath, parentDir, fileName },
		);
	}

	async clearCalls(cmd?: string): Promise<void> {
		await this.page.evaluate((c: string | undefined) => {
			const store = (window as unknown as WindowWithMock).__TAURI_MOCK__;
			if (!store) return;
			if (c) {
				store.calls[c] = [];
			} else {
				store.calls = {};
			}
		}, cmd);
	}
}

export const modKey = process.platform === "darwin" ? "Meta" : "Control";
