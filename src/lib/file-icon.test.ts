import { File, FileCode, FileJson, FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { getFileIcon } from "./file-icon";

describe("getFileIcon", () => {
	it("returns FileText for .md files", () => {
		expect(getFileIcon("readme.md")).toBe(FileText);
	});

	it("returns FileText for .txt files", () => {
		expect(getFileIcon("notes.txt")).toBe(FileText);
	});

	it("returns FileJson for .json files", () => {
		expect(getFileIcon("package.json")).toBe(FileJson);
	});

	it("returns FileCode for .ts files", () => {
		expect(getFileIcon("index.ts")).toBe(FileCode);
	});

	it("returns FileCode for .tsx files", () => {
		expect(getFileIcon("App.tsx")).toBe(FileCode);
	});

	it("returns FileCode for .js files", () => {
		expect(getFileIcon("main.js")).toBe(FileCode);
	});

	it("returns FileCode for .css files", () => {
		expect(getFileIcon("style.css")).toBe(FileCode);
	});

	it("returns FileCode for .html files", () => {
		expect(getFileIcon("index.html")).toBe(FileCode);
	});

	it("returns File for unknown extensions", () => {
		expect(getFileIcon("image.png")).toBe(File);
	});

	it("returns File for files without extension", () => {
		expect(getFileIcon("Makefile")).toBe(File);
	});

	it("handles uppercase extensions", () => {
		expect(getFileIcon("README.MD")).toBe(FileText);
	});
});
