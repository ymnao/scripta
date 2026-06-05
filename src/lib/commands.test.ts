import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { kindError } from "../__test-utils__/structured-error";
import {
	deleteEntry,
	listDirectory,
	readFile,
	renameEntry,
	scanUnresolvedWikilinks,
	searchFilenames,
	searchFiles,
	writeFile,
} from "./commands";

// test-setup.ts の beforeEach が `window.api` を毎回新しい `createApiMock()` で置き換えるため、
// 各テストでは `(window.api.<fn> as Mock).mockXxxValueOnce(...)` で個別の挙動を上書きする。
//
// non-transient 判定は構造化エラーの kind ベース（renderer は getErrorKind で復元）になったため、
// 「再試行しない」検証には kindError() で kind 付きエラーを reject させる
// （ここでは own `kind` プロパティを直接持つ mock を使う。実 IPC 経路で kind が message
// 経由になることの round-trip は e2e structured-error.electron.spec.ts でカバー）。

describe("readFile with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns result on first success", async () => {
		const mockedReadFile = window.api.readFile as Mock;
		mockedReadFile.mockResolvedValue("content");
		const result = await readFile("/test.md");
		expect(result).toBe("content");
		expect(mockedReadFile).toHaveBeenCalledTimes(1);
	});

	it("retries on transient error and succeeds", async () => {
		const mockedReadFile = window.api.readFile as Mock;
		mockedReadFile.mockRejectedValueOnce("Connection timed out").mockResolvedValue("content");

		const promise = readFile("/test.md");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toBe("content");
		expect(mockedReadFile).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		const mockedReadFile = window.api.readFile as Mock;
		const err = kindError("NOT_FOUND", "Not found: /test.md");
		mockedReadFile.mockRejectedValue(err);

		await expect(readFile("/test.md")).rejects.toBe(err);
		expect(mockedReadFile).toHaveBeenCalledTimes(1);
	});

	it("throws after max retries", async () => {
		const mockedReadFile = window.api.readFile as Mock;
		mockedReadFile.mockRejectedValue("timeout");

		const promise = readFile("/test.md");
		// Suppress unhandled rejection warning — we assert below
		promise.catch(() => {});
		await vi.advanceTimersByTimeAsync(200);
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(800);

		await expect(promise).rejects.toBe("timeout");
		expect(mockedReadFile).toHaveBeenCalledTimes(4);
	});
});

describe("writeFile with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns on first success", async () => {
		const mockedWriteFile = window.api.writeFile as Mock;
		mockedWriteFile.mockResolvedValue(undefined);
		await writeFile("/test.md", "content");
		expect(mockedWriteFile).toHaveBeenCalledTimes(1);
	});

	it("retries on transient error and succeeds", async () => {
		const mockedWriteFile = window.api.writeFile as Mock;
		mockedWriteFile.mockRejectedValueOnce("network error").mockResolvedValue(undefined);

		const promise = writeFile("/test.md", "content");
		await vi.advanceTimersByTimeAsync(200);
		await promise;

		expect(mockedWriteFile).toHaveBeenCalledTimes(2);
	});

	it("does not retry on permission error", async () => {
		const mockedWriteFile = window.api.writeFile as Mock;
		const err = kindError("EACCES", "Permission denied");
		mockedWriteFile.mockRejectedValue(err);

		await expect(writeFile("/test.md", "content")).rejects.toBe(err);
		expect(mockedWriteFile).toHaveBeenCalledTimes(1);
	});
});

describe("listDirectory with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		const mockedListDirectory = window.api.listDirectory as Mock;
		mockedListDirectory
			.mockRejectedValueOnce("Device or resource busy (os error 16)")
			.mockResolvedValue([]);

		const promise = listDirectory("/workspace");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toEqual([]);
		expect(mockedListDirectory).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		const mockedListDirectory = window.api.listDirectory as Mock;
		const err = kindError("NOT_FOUND", "Not found: /workspace");
		mockedListDirectory.mockRejectedValue(err);

		await expect(listDirectory("/workspace")).rejects.toBe(err);
		expect(mockedListDirectory).toHaveBeenCalledTimes(1);
	});
});

describe("renameEntry with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		const mockedRenameEntry = window.api.renameEntry as Mock;
		mockedRenameEntry
			.mockRejectedValueOnce("Device or resource busy (os error 16)")
			.mockResolvedValue(undefined);

		const promise = renameEntry("/old.md", "/new.md");
		await vi.advanceTimersByTimeAsync(200);
		await promise;

		expect(mockedRenameEntry).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		const mockedRenameEntry = window.api.renameEntry as Mock;
		const err = kindError("TARGET_ALREADY_EXISTS", "Target already exists: /new.md");
		mockedRenameEntry.mockRejectedValue(err);

		await expect(renameEntry("/old.md", "/new.md")).rejects.toBe(err);
		expect(mockedRenameEntry).toHaveBeenCalledTimes(1);
	});
});

describe("deleteEntry with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		const mockedDeleteEntry = window.api.deleteEntry as Mock;
		mockedDeleteEntry
			.mockRejectedValueOnce("Device or resource busy (os error 16)")
			.mockResolvedValue(undefined);

		const promise = deleteEntry("/test.md");
		await vi.advanceTimersByTimeAsync(200);
		await promise;

		expect(mockedDeleteEntry).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		const mockedDeleteEntry = window.api.deleteEntry as Mock;
		const err = kindError("EACCES", "Permission denied");
		mockedDeleteEntry.mockRejectedValue(err);

		await expect(deleteEntry("/test.md")).rejects.toBe(err);
		expect(mockedDeleteEntry).toHaveBeenCalledTimes(1);
	});
});

describe("searchFiles with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		const mockedSearchFiles = window.api.searchFiles as Mock;
		mockedSearchFiles
			.mockRejectedValueOnce("Resource temporarily unavailable (os error 11)")
			.mockResolvedValue([]);

		const promise = searchFiles("/workspace", "query");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toEqual([]);
		expect(mockedSearchFiles).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		const mockedSearchFiles = window.api.searchFiles as Mock;
		const err = kindError("NOT_FOUND", "Not found: /workspace");
		mockedSearchFiles.mockRejectedValue(err);

		await expect(searchFiles("/workspace", "query")).rejects.toBe(err);
		expect(mockedSearchFiles).toHaveBeenCalledTimes(1);
	});
});

describe("searchFilenames with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		const mockedSearchFilenames = window.api.searchFilenames as Mock;
		mockedSearchFilenames
			.mockRejectedValueOnce("Resource temporarily unavailable (os error 35)")
			.mockResolvedValue([]);

		const promise = searchFilenames("/workspace", "query");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toEqual([]);
		expect(mockedSearchFilenames).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		const mockedSearchFilenames = window.api.searchFilenames as Mock;
		const err = kindError("NOT_FOUND", "Not found: /workspace");
		mockedSearchFilenames.mockRejectedValue(err);

		await expect(searchFilenames("/workspace", "query")).rejects.toBe(err);
		expect(mockedSearchFilenames).toHaveBeenCalledTimes(1);
	});
});

describe("scanUnresolvedWikilinks with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		const mockedScan = window.api.scanUnresolvedWikilinks as Mock;
		mockedScan
			.mockRejectedValueOnce("Resource temporarily unavailable (os error 11)")
			.mockResolvedValue([]);

		const promise = scanUnresolvedWikilinks("/workspace");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toEqual([]);
		expect(mockedScan).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		const mockedScan = window.api.scanUnresolvedWikilinks as Mock;
		const err = kindError("NOT_FOUND", "Not found: /workspace");
		mockedScan.mockRejectedValue(err);

		await expect(scanUnresolvedWikilinks("/workspace")).rejects.toBe(err);
		expect(mockedScan).toHaveBeenCalledTimes(1);
	});
});
