import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn().mockResolvedValue(undefined),
	listDirectory: vi.fn(),
	pathExists: vi.fn(),
}));

const { readFile, writeFile, listDirectory, pathExists } = await import("./commands");
const {
	loadIcons,
	saveIcons,
	loadPromptTemplate,
	savePromptTemplate,
	getScriptaPromptTemplatePath,
	scriptaDirExists,
	fileExists,
	isWorkspaceInitialized,
	markWorkspaceInitialized,
	getReadmeTemplatePath,
	getClaudeMdTemplatePath,
	getGitignorePath,
	getSyntaxGuidePath,
	README_TEMPLATE,
	CLAUDE_MD_TEMPLATE,
	GITIGNORE_TEMPLATE,
	SYNTAX_GUIDE_TEMPLATE,
} = await import("./scripta-config");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;
const mockedListDirectory = listDirectory as Mock;
const mockedPathExists = pathExists as Mock;

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

describe("scriptaDirExists", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when .scripta directory exists", async () => {
		mockedListDirectory.mockResolvedValue([]);
		const result = await scriptaDirExists("/workspace");
		expect(result).toBe(true);
		expect(mockedListDirectory).toHaveBeenCalledWith("/workspace/.scripta");
	});

	it("returns false when .scripta directory does not exist", async () => {
		mockedListDirectory.mockRejectedValue(new Error("Not found"));
		const result = await scriptaDirExists("/workspace");
		expect(result).toBe(false);
	});
});

describe("fileExists", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when file exists", async () => {
		mockedPathExists.mockResolvedValue(true);
		const result = await fileExists("/workspace/file.md");
		expect(result).toBe(true);
		expect(mockedPathExists).toHaveBeenCalledWith("/workspace/file.md");
	});

	it("returns false when file does not exist", async () => {
		mockedPathExists.mockResolvedValue(false);
		const result = await fileExists("/workspace/file.md");
		expect(result).toBe(false);
	});
});

describe("isWorkspaceInitialized", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when initialized.json exists", async () => {
		mockedPathExists.mockResolvedValue(true);
		const result = await isWorkspaceInitialized("/workspace");
		expect(result).toBe(true);
		expect(mockedPathExists).toHaveBeenCalledWith("/workspace/.scripta/initialized.json");
	});

	it("returns false when initialized.json does not exist", async () => {
		mockedPathExists.mockResolvedValue(false);
		const result = await isWorkspaceInitialized("/workspace");
		expect(result).toBe(false);
	});
});

describe("markWorkspaceInitialized", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("writes initialized.json (parent dirs created by writeFile)", async () => {
		await markWorkspaceInitialized("/workspace");
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/.scripta/initialized.json",
			expect.stringContaining("initializedAt"),
		);
	});
});

describe("template paths", () => {
	it("getReadmeTemplatePath returns correct path", () => {
		expect(getReadmeTemplatePath("/workspace")).toBe("/workspace/README.md");
	});

	it("getClaudeMdTemplatePath returns correct path", () => {
		expect(getClaudeMdTemplatePath("/workspace")).toBe("/workspace/CLAUDE.md");
	});

	it("getGitignorePath returns correct path", () => {
		expect(getGitignorePath("/workspace")).toBe("/workspace/.gitignore");
	});

	it("getSyntaxGuidePath returns correct path", () => {
		expect(getSyntaxGuidePath("/workspace")).toBe("/workspace/.scripta/syntax-guide.md");
	});
});

describe("template contents", () => {
	it("README_TEMPLATE contains expected sections", () => {
		expect(README_TEMPLATE).toContain("## 概要");
		expect(README_TEMPLATE).toContain("## セットアップ");
		expect(README_TEMPLATE).toContain("syntax-guide.md");
	});

	it("CLAUDE_MD_TEMPLATE contains expected sections", () => {
		expect(CLAUDE_MD_TEMPLATE).toContain("## プロジェクト概要");
		expect(CLAUDE_MD_TEMPLATE).toContain("## コーディング規約");
	});

	it("GITIGNORE_TEMPLATE contains .scripta/", () => {
		expect(GITIGNORE_TEMPLATE).toContain(".scripta/");
		expect(GITIGNORE_TEMPLATE).toContain(".DS_Store");
	});

	it("SYNTAX_GUIDE_TEMPLATE contains scripta features", () => {
		expect(SYNTAX_GUIDE_TEMPLATE).toContain("Wiki Links");
		expect(SYNTAX_GUIDE_TEMPLATE).toContain("KaTeX");
		expect(SYNTAX_GUIDE_TEMPLATE).toContain("Mermaid");
		expect(SYNTAX_GUIDE_TEMPLATE).toContain("エクスポート");
	});
});
