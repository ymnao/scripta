import type { Page } from "@playwright/test";

interface FileEntry {
	name: string;
	path: string;
	isDirectory: boolean;
}

export interface MockFileSystem {
	files: Record<string, string>;
	directories: Record<string, FileEntry[]>;
}

interface TauriMockStore {
	handlers: Record<string, (args: Record<string, unknown>) => unknown>;
	calls: Record<string, Array<Record<string, unknown>>>;
	dialogResult: string | null;
}

export class TauriMock {
	constructor(private page: Page) {}

	async setup(fs: MockFileSystem, dialogResult: string | null = null): Promise<void> {
		const filesJson = JSON.stringify(fs.files);
		const directoriesJson = JSON.stringify(fs.directories);

		await this.page.addInitScript(
			({
				files,
				directories,
				dialog,
			}: { files: string; directories: string; dialog: string | null }) => {
				const parsedFiles: Record<string, string> = JSON.parse(files);
				const parsedDirs: Record<string, FileEntry[]> = JSON.parse(directories);

				interface FileEntry {
					name: string;
					path: string;
					isDirectory: boolean;
				}

				interface Store {
					handlers: Record<string, (args: Record<string, unknown>) => unknown>;
					calls: Record<string, Array<Record<string, unknown>>>;
					dialogResult: string | null;
				}

				const win = window as Window & { __TAURI_MOCK__?: Store };
				const store: Store = {
					handlers: {},
					calls: {},
					dialogResult: dialog,
				};
				win.__TAURI_MOCK__ = store;

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
					return [];
				};
			},
			{ files: filesJson, directories: directoriesJson, dialog: dialogResult },
		);
	}

	async getCalls(cmd: string): Promise<Array<Record<string, unknown>>> {
		return this.page.evaluate((c: string) => {
			const win = window as Window & { __TAURI_MOCK__?: TauriMockStore };

			interface TauriMockStore {
				calls: Record<string, Array<Record<string, unknown>>>;
			}

			return win.__TAURI_MOCK__?.calls[c] ?? [];
		}, cmd);
	}

	async setFileContent(path: string, content: string): Promise<void> {
		await this.page.evaluate(
			({ path, content }: { path: string; content: string }) => {
				interface TauriMockStore {
					handlers: Record<string, (args: Record<string, unknown>) => unknown>;
				}

				const win = window as Window & { __TAURI_MOCK__?: TauriMockStore };
				const handler = win.__TAURI_MOCK__?.handlers.write_file;
				if (handler) {
					handler({ path, content });
				}
			},
			{ path, content },
		);
	}

	async clearCalls(cmd?: string): Promise<void> {
		await this.page.evaluate((c: string | undefined) => {
			interface TauriMockStore {
				calls: Record<string, Array<Record<string, unknown>>>;
			}

			const win = window as Window & { __TAURI_MOCK__?: TauriMockStore };
			if (!win.__TAURI_MOCK__) return;
			if (c) {
				win.__TAURI_MOCK__.calls[c] = [];
			} else {
				win.__TAURI_MOCK__.calls = {};
			}
		}, cmd);
	}
}

export const modKey = process.platform === "darwin" ? "Meta" : "Control";
