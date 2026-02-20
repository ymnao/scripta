import { describe, expect, it } from "vitest";
import { parentDir } from "./images";

describe("parentDir", () => {
	it("extracts parent from Unix path", () => {
		expect(parentDir("/home/user/docs/note.md")).toBe("/home/user/docs");
	});

	it("extracts parent from Windows path", () => {
		expect(parentDir("C:\\Users\\user\\docs\\note.md")).toBe("C:\\Users\\user\\docs");
	});

	it("extracts parent from Windows path with forward slashes", () => {
		expect(parentDir("C:/Users/user/docs/note.md")).toBe("C:/Users/user/docs");
	});

	it("handles root Unix path", () => {
		expect(parentDir("/file.md")).toBe("");
	});

	it("handles root Windows path", () => {
		expect(parentDir("C:\\file.md")).toBe("C:");
	});

	it("returns empty string for filename without separators", () => {
		expect(parentDir("file.md")).toBe("");
	});

	it("handles mixed separators (prefers last separator)", () => {
		expect(parentDir("C:\\Users/docs\\note.md")).toBe("C:\\Users/docs");
	});

	it("handles trailing separator", () => {
		expect(parentDir("/home/user/")).toBe("/home/user");
	});
});
