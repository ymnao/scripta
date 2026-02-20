import type { Page } from "@playwright/test";
import type { FileEntry, TauriMockStore } from "../mocks/types";

export interface MockFileSystem {
	files: Record<string, string>;
	directories: Record<string, FileEntry[]>;
}

type WindowWithMock = Window & { __TAURI_MOCK__?: TauriMockStore };

export class TauriMock {
	private page: Page;
	constructor(page: Page) {
		this.page = page;
	}

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
				const parsedDirs: Record<
					string,
					Array<{ name: string; path: string; isDirectory: boolean }>
				> = JSON.parse(directories);

				const store = {
					handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
					calls: {} as Record<string, Array<Record<string, unknown>>>,
					dialogResult: dialog,
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
					return [];
				};
			},
			{ files: filesJson, directories: directoriesJson, dialog: dialogResult },
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
