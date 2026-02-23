import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

const { invoke } = await import("@tauri-apps/api/core");
const { readFile, writeFile } = await import("./commands");

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
