import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn().mockResolvedValue(undefined),
}));

const { readFile, writeFile } = await import("./commands");
const {
	loadIcons,
	saveIcons,
	loadPromptTemplate,
	savePromptTemplate,
	getScriptaPromptTemplatePath,
} = await import("./scripta-config");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;

describe("loadIcons", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns parsed icons from .scripta/icons.json", async () => {
		mockedReadFile.mockResolvedValue('{"docs/readme.md":"📄","src":"🔧"}');
		const result = await loadIcons("/workspace");
		expect(result).toEqual({ "docs/readme.md": "📄", src: "🔧" });
		expect(mockedReadFile).toHaveBeenCalledWith("/workspace/.scripta/icons.json");
	});

	it("returns empty object when file does not exist", async () => {
		mockedReadFile.mockRejectedValue(new Error("Not found"));
		const result = await loadIcons("/workspace");
		expect(result).toEqual({});
	});

	it("returns empty object when JSON is invalid", async () => {
		mockedReadFile.mockResolvedValue("not json");
		const result = await loadIcons("/workspace");
		expect(result).toEqual({});
	});

	it("returns empty object when JSON is an array", async () => {
		mockedReadFile.mockResolvedValue("[1,2,3]");
		const result = await loadIcons("/workspace");
		expect(result).toEqual({});
	});

	it("returns empty object when JSON is null", async () => {
		mockedReadFile.mockResolvedValue("null");
		const result = await loadIcons("/workspace");
		expect(result).toEqual({});
	});

	it("filters out non-string values", async () => {
		mockedReadFile.mockResolvedValue('{"valid":"📄","num":42,"obj":{},"arr":[]}');
		const result = await loadIcons("/workspace");
		expect(result).toEqual({ valid: "📄" });
	});
});

describe("saveIcons", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("writes icons as JSON to .scripta/icons.json", async () => {
		await saveIcons("/workspace", { "file.md": "📝" });
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/.scripta/icons.json",
			expect.stringContaining('"file.md"'),
		);
	});

	it("writes formatted JSON with tabs", async () => {
		await saveIcons("/workspace", { a: "1" });
		const written = mockedWriteFile.mock.calls[0][1] as string;
		expect(written).toContain("\t");
	});
});

describe("loadPromptTemplate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns template content when file exists", async () => {
		mockedReadFile.mockResolvedValue("# Template\n{title}\n{content}");
		const result = await loadPromptTemplate("/workspace");
		expect(result).toBe("# Template\n{title}\n{content}");
		expect(mockedReadFile).toHaveBeenCalledWith("/workspace/.scripta/prompt-template.md");
	});

	it("returns null when file does not exist", async () => {
		mockedReadFile.mockRejectedValue(new Error("Not found"));
		const result = await loadPromptTemplate("/workspace");
		expect(result).toBeNull();
	});
});

describe("savePromptTemplate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("writes template to .scripta/prompt-template.md", async () => {
		await savePromptTemplate("/workspace", "# Custom\n{title}");
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/.scripta/prompt-template.md",
			"# Custom\n{title}",
		);
	});
});

describe("getScriptaPromptTemplatePath", () => {
	it("returns correct path", () => {
		expect(getScriptaPromptTemplatePath("/workspace")).toBe(
			"/workspace/.scripta/prompt-template.md",
		);
	});
});
