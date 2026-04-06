import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

const { invoke } = await import("@tauri-apps/api/core");
const {
	readFile,
	writeFile,
	listDirectory,
	renameEntry,
	deleteEntry,
	searchFiles,
	searchFilenames,
} = await import("./commands");

const mockedInvoke = invoke as Mock;

describe("readFile with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedInvoke.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns result on first success", async () => {
		mockedInvoke.mockResolvedValue("content");
		const result = await readFile("/test.md");
		expect(result).toBe("content");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});

	it("retries on transient error and succeeds", async () => {
		mockedInvoke.mockRejectedValueOnce("Connection timed out").mockResolvedValue("content");

		const promise = readFile("/test.md");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toBe("content");
		expect(mockedInvoke).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		mockedInvoke.mockRejectedValue("Not found: /test.md");

		await expect(readFile("/test.md")).rejects.toBe("Not found: /test.md");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});

	it("throws after max retries", async () => {
		mockedInvoke.mockRejectedValue("timeout");

		const promise = readFile("/test.md");
		// Suppress unhandled rejection warning — we assert below
		promise.catch(() => {});
		await vi.advanceTimersByTimeAsync(200);
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(800);

		await expect(promise).rejects.toBe("timeout");
		expect(mockedInvoke).toHaveBeenCalledTimes(4);
	});
});

describe("writeFile with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedInvoke.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns on first success", async () => {
		mockedInvoke.mockResolvedValue(undefined);
		await writeFile("/test.md", "content");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});

	it("retries on transient error and succeeds", async () => {
		mockedInvoke.mockRejectedValueOnce("network error").mockResolvedValue(undefined);

		const promise = writeFile("/test.md", "content");
		await vi.advanceTimersByTimeAsync(200);
		await promise;

		expect(mockedInvoke).toHaveBeenCalledTimes(2);
	});

	it("does not retry on permission error", async () => {
		mockedInvoke.mockRejectedValue("Permission denied (os error 13)");

		await expect(writeFile("/test.md", "content")).rejects.toBe("Permission denied (os error 13)");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});
});

describe("listDirectory with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedInvoke.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		mockedInvoke
			.mockRejectedValueOnce("Device or resource busy (os error 16)")
			.mockResolvedValue([]);

		const promise = listDirectory("/workspace");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toEqual([]);
		expect(mockedInvoke).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		mockedInvoke.mockRejectedValue("Not found: /workspace");

		await expect(listDirectory("/workspace")).rejects.toBe("Not found: /workspace");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});
});

describe("renameEntry with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedInvoke.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		mockedInvoke
			.mockRejectedValueOnce("Device or resource busy (os error 16)")
			.mockResolvedValue(undefined);

		const promise = renameEntry("/old.md", "/new.md");
		await vi.advanceTimersByTimeAsync(200);
		await promise;

		expect(mockedInvoke).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		mockedInvoke.mockRejectedValue("Target already exists: /new.md");

		await expect(renameEntry("/old.md", "/new.md")).rejects.toBe("Target already exists: /new.md");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});
});

describe("deleteEntry with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedInvoke.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		mockedInvoke
			.mockRejectedValueOnce("Device or resource busy (os error 16)")
			.mockResolvedValue(undefined);

		const promise = deleteEntry("/test.md");
		await vi.advanceTimersByTimeAsync(200);
		await promise;

		expect(mockedInvoke).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		mockedInvoke.mockRejectedValue("Permission denied (os error 13)");

		await expect(deleteEntry("/test.md")).rejects.toBe("Permission denied (os error 13)");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});
});

describe("searchFiles with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedInvoke.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		mockedInvoke
			.mockRejectedValueOnce("Resource temporarily unavailable (os error 11)")
			.mockResolvedValue([]);

		const promise = searchFiles("/workspace", "query");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toEqual([]);
		expect(mockedInvoke).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		mockedInvoke.mockRejectedValue("Not found: /workspace");

		await expect(searchFiles("/workspace", "query")).rejects.toBe("Not found: /workspace");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});
});

describe("searchFilenames with retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedInvoke.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries on transient error and succeeds", async () => {
		mockedInvoke
			.mockRejectedValueOnce("Resource temporarily unavailable (os error 35)")
			.mockResolvedValue([]);

		const promise = searchFilenames("/workspace", "query");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toEqual([]);
		expect(mockedInvoke).toHaveBeenCalledTimes(2);
	});

	it("does not retry on non-transient error", async () => {
		mockedInvoke.mockRejectedValue("Not found: /workspace");

		await expect(searchFilenames("/workspace", "query")).rejects.toBe("Not found: /workspace");
		expect(mockedInvoke).toHaveBeenCalledTimes(1);
	});
});
