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

				store.handlers.create_directory = (args: Record<string, unknown>) => {
					const path = args.path as string;
					if (path in parsedDirs) {
						throw new Error(`Already exists: ${path}`);
					}
					parsedDirs[path] = [];
					// Add to parent directory listing
					const parts = path.split("/");
					const name = parts[parts.length - 1];
					const parentPath = parts.slice(0, -1).join("/");
					if (parentPath in parsedDirs) {
						parsedDirs[parentPath].push({
							name,
							path,
							isDirectory: true,
						});
					}
				};

				store.handlers.rename_entry = (args: Record<string, unknown>) => {
					const oldPath = args.oldPath as string;
					const newPath = args.newPath as string;
					const oldPrefix = `${oldPath}/`;
					// Rename descendant files
					for (const key of Object.keys(parsedFiles)) {
						if (key.startsWith(oldPrefix)) {
							parsedFiles[newPath + key.slice(oldPath.length)] = parsedFiles[key];
							delete parsedFiles[key];
						}
					}
					// Rename file itself
					if (oldPath in parsedFiles) {
						parsedFiles[newPath] = parsedFiles[oldPath];
						delete parsedFiles[oldPath];
					}
					// Rename descendant directories and update their children's paths
					for (const key of Object.keys(parsedDirs)) {
						if (key.startsWith(oldPrefix)) {
							const newKey = newPath + key.slice(oldPath.length);
							parsedDirs[newKey] = parsedDirs[key].map((e) => ({
								...e,
								path: newPath + e.path.slice(oldPath.length),
							}));
							delete parsedDirs[key];
						}
					}
					// Rename directory itself and update children's paths
					if (oldPath in parsedDirs) {
						parsedDirs[newPath] = parsedDirs[oldPath].map((e) => ({
							...e,
							path: newPath + e.path.slice(oldPath.length),
						}));
						delete parsedDirs[oldPath];
					}
					// Update parent directory entry
					const oldParts = oldPath.split("/");
					const parentPath = oldParts.slice(0, -1).join("/");
					if (parentPath in parsedDirs) {
						const entry = parsedDirs[parentPath].find((e) => e.path === oldPath);
						if (entry) {
							const newParts = newPath.split("/");
							entry.name = newParts[newParts.length - 1];
							entry.path = newPath;
						}
					}
				};

				store.handlers.delete_entry = (args: Record<string, unknown>) => {
					const path = args.path as string;
					const prefix = `${path}/`;
					// Delete descendant files
					for (const key of Object.keys(parsedFiles)) {
						if (key.startsWith(prefix)) {
							delete parsedFiles[key];
						}
					}
					// Delete file itself
					delete parsedFiles[path];
					// Delete descendant directories
					for (const key of Object.keys(parsedDirs)) {
						if (key.startsWith(prefix)) {
							delete parsedDirs[key];
						}
					}
					// Delete directory listing
					delete parsedDirs[path];
					// Remove from parent directory
					const parts = path.split("/");
					const parentPath = parts.slice(0, -1).join("/");
					if (parentPath in parsedDirs) {
						parsedDirs[parentPath] = parsedDirs[parentPath].filter((e) => e.path !== path);
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

				store.handlers.export_pdf = () => {
					// no-op: just record the call
					return undefined;
				};

				store.handlers.file_exists = (args: Record<string, unknown>) => {
					const path = args.path as string;
					return path in parsedFiles || path in parsedDirs;
				};

				store.handlers.write_new_file = (args: Record<string, unknown>) => {
					const path = args.path as string;
					const content = args.content as string;
					if (path in parsedFiles) {
						throw new Error(`Already exists: ${path}`);
					}
					parsedFiles[path] = content;
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

				store.handlers.scan_unresolved_wikilinks = (args: Record<string, unknown>) => {
					const workspacePath = args.workspacePath as string;
					const mdFiles = collectMdFiles(workspacePath);
					// Build set of existing basenames (NFC normalized, .md stripped)
					const existingPages = new Set<string>();
					for (const filePath of mdFiles) {
						const parts = filePath.split("/");
						const fileName = parts[parts.length - 1];
						if (fileName.toLowerCase().endsWith(".md")) {
							existingPages.add(fileName.slice(0, -3).normalize("NFC"));
						}
					}
					// Scan for wikilinks
					const unresolvedMap: Record<
						string,
						Array<{
							filePath: string;
							lineNumber: number;
							lineContent: string;
							contextBefore: string[];
							contextAfter: string[];
						}>
					> = {};
					for (const filePath of mdFiles) {
						const content = parsedFiles[filePath];
						if (!content) continue;
						const lines = content.split("\n");
						let inCodeBlock = false;
						const re = /\[\[([^[\]\n\r]+)\]\]/g;
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i];
							const trimmed = line.trimStart();
							if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
								inCodeBlock = !inCodeBlock;
								continue;
							}
							if (inCodeBlock) continue;
							re.lastIndex = 0;
							let m: RegExpExecArray | null = null;
							while (true) {
								m = re.exec(line);
								if (!m) break;
								const inner = m[1];
								const pipeIdx = inner.indexOf("|");
								const page = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
								if (
									!page ||
									page.includes("/") ||
									page.includes("\\") ||
									page === "." ||
									page === ".." ||
									page.includes("..")
								)
									continue;
								const stripped = page.toLowerCase().endsWith(".md") ? page.slice(0, -3) : page;
								const normalized = stripped.normalize("NFC");
								if (!normalized || existingPages.has(normalized)) continue;
								if (!unresolvedMap[normalized]) unresolvedMap[normalized] = [];
								const contextBefore = lines.slice(Math.max(0, i - 3), i).map((l: string) => l);
								const contextAfter = lines
									.slice(i + 1, Math.min(lines.length, i + 4))
									.map((l: string) => l);
								unresolvedMap[normalized].push({
									filePath,
									lineNumber: i + 1,
									lineContent: line,
									contextBefore,
									contextAfter,
								});
							}
						}
					}
					return Object.entries(unresolvedMap)
						.map(([pageName, references]) => ({ pageName, references }))
						.sort((a, b) => a.pageName.localeCompare(b.pageName));
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
			}: {
				filePath: string;
				parentDir: string;
				fileName: string;
			}) => {
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

	async setDialogResult(result: string | null): Promise<void> {
		await this.page.evaluate((r: string | null) => {
			const store = (window as unknown as WindowWithMock).__TAURI_MOCK__;
			if (store) store.dialogResult = r;
		}, result);
	}

	async addFiles(
		files: Record<string, string>,
		directories: Record<string, Array<{ name: string; path: string; isDirectory: boolean }>>,
	): Promise<void> {
		await this.page.evaluate(
			({
				files,
				directories,
			}: {
				files: Record<string, string>;
				directories: Record<string, Array<{ name: string; path: string; isDirectory: boolean }>>;
			}) => {
				const store = (window as unknown as WindowWithMock).__TAURI_MOCK__;
				if (!store?._files || !store?._directories) return;
				Object.assign(store._files, files);
				Object.assign(store._directories, directories);
			},
			{ files, directories },
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
