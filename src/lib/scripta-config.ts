import { fileExists as fileExistsCmd, listDirectory, readFile, writeFile } from "./commands";
import { joinPath } from "./path";

const SCRIPTA_DIR = ".scripta";
const ICONS_FILE = "icons.json";
const PROMPT_TEMPLATE_FILE = "prompt-template.md";
const INITIALIZED_FILE = "initialized.json";
const SCRATCHPAD_FILE = "scratchpad.md";
const SCRATCHPAD_ARCHIVE_DIR = "scratchpad-archive";

export function getScriptaDir(workspacePath: string): string {
	return joinPath(workspacePath, SCRIPTA_DIR);
}

export async function scriptaDirExists(workspacePath: string): Promise<boolean> {
	try {
		await listDirectory(getScriptaDir(workspacePath));
		return true;
	} catch {
		return false;
	}
}

export function getScriptaPromptTemplatePath(workspacePath: string): string {
	return joinPath(getScriptaDir(workspacePath), PROMPT_TEMPLATE_FILE);
}

export async function loadIcons(workspacePath: string): Promise<Record<string, string>> {
	try {
		const raw = await readFile(joinPath(getScriptaDir(workspacePath), ICONS_FILE));
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const result: Record<string, string> = Object.create(null);
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (key === "__proto__" || key === "constructor" || key === "prototype") {
					continue;
				}
				if (typeof value === "string") {
					result[key] = value;
				}
			}
			return result;
		}
		return Object.create(null) as Record<string, string>;
	} catch {
		return Object.create(null) as Record<string, string>;
	}
}

export async function saveIcons(
	workspacePath: string,
	icons: Record<string, string>,
): Promise<void> {
	const content = JSON.stringify(icons, null, "\t");
	await writeFile(joinPath(getScriptaDir(workspacePath), ICONS_FILE), content);
}

export async function loadPromptTemplate(workspacePath: string): Promise<string | null> {
	try {
		return await readFile(getScriptaPromptTemplatePath(workspacePath));
	} catch {
		return null;
	}
}

export async function savePromptTemplate(workspacePath: string, content: string): Promise<void> {
	await writeFile(getScriptaPromptTemplatePath(workspacePath), content);
}

// --- Scratchpad paths ---

export function getScratchpadPath(workspacePath: string): string {
	return joinPath(getScriptaDir(workspacePath), SCRATCHPAD_FILE);
}

export function getScratchpadArchiveDir(workspacePath: string): string {
	return joinPath(getScriptaDir(workspacePath), SCRATCHPAD_ARCHIVE_DIR);
}

export function getScratchpadArchivePath(workspacePath: string, date: string): string {
	return joinPath(getScratchpadArchiveDir(workspacePath), `${date}.md`);
}

// --- Workspace initialization ---

export function fileExists(path: string): Promise<boolean> {
	return fileExistsCmd(path);
}

export async function isWorkspaceInitialized(workspacePath: string): Promise<boolean> {
	return fileExists(joinPath(getScriptaDir(workspacePath), INITIALIZED_FILE));
}

export async function markWorkspaceInitialized(workspacePath: string): Promise<void> {
	await writeFile(
		joinPath(getScriptaDir(workspacePath), INITIALIZED_FILE),
		JSON.stringify({ initializedAt: new Date().toISOString() }, null, "\t"),
	);
}

// --- Template paths ---

export function getReadmeTemplatePath(workspacePath: string): string {
	return joinPath(workspacePath, "README.md");
}

export function getClaudeMdTemplatePath(workspacePath: string): string {
	return joinPath(workspacePath, "CLAUDE.md");
}

export function getGitignorePath(workspacePath: string): string {
	return joinPath(workspacePath, ".gitignore");
}

export function getSyntaxGuidePath(workspacePath: string): string {
	return joinPath(getScriptaDir(workspacePath), "syntax-guide.md");
}

// --- Template contents ---

export const README_TEMPLATE = `# プロジェクト名

<!-- このファイルはプロジェクトの概要を記述するためのテンプレートです。自由に編集してください。 -->
<!-- scripta の記法については .scripta/syntax-guide.md を参照してください。 -->

## 概要

## セットアップ

## 使い方

`;

export const CLAUDE_MD_TEMPLATE = `# プロジェクトガイドライン

<!-- このファイルは Claude Code 等の AI エージェントに読み込まれるプロジェクト固有の指示書です。 -->
<!-- プロジェクトの規約や注意点を記述すると、AI がコンテキストとして参照します。 -->
<!-- 参考: https://docs.anthropic.com/en/docs/claude-code/memory -->

## プロジェクト概要

<!-- 技術スタック、アーキテクチャの概要を記述 -->

## 開発コマンド

\`\`\`bash
# 例: 開発サーバー起動
# npm run dev
\`\`\`

## コーディング規約

<!-- 命名規則、ディレクトリ構成ルール、禁止事項など -->

## テスト

<!-- テストの実行方法、テスト方針 -->

`;

export const GITIGNORE_TEMPLATE = `# scripta
.scripta/

# OS
.DS_Store
Thumbs.db

# Editor
*.swp
*~
`;

export const SYNTAX_GUIDE_TEMPLATE = `# scripta 記法ガイド

このドキュメントは scripta で使える Markdown 記法のリファレンスです。

## 基本記法

### 見出し

\`# 見出し1\` から \`###### 見出し6\` まで対応しています。

### テキスト装飾

| 記法 | 表示 |
|------|------|
| \`**太字**\` | **太字** |
| \`*斜体*\` | *斜体* |
| \`~~取り消し線~~\` | ~~取り消し線~~ |
| \`\\\`インラインコード\\\`\` | \`インラインコード\` |

### リスト

\`\`\`markdown
- 箇条書き
  - ネスト可能
    - さらにネスト

1. 番号付きリスト
2. 自動採番

- [ ] タスクリスト（未完了）
- [x] タスクリスト（完了）
\`\`\`

### リンクと画像

\`\`\`markdown
[リンクテキスト](https://example.com)
![代替テキスト](image.png)
\`\`\`

### 引用

\`\`\`markdown
> 引用テキスト
> 複数行も可能
\`\`\`

### 水平線

\`\`\`markdown
---
\`\`\`

## テーブル

\`\`\`markdown
| 左揃え | 中央揃え | 右揃え |
|:-------|:-------:|-------:|
| A      |    B    |      C |
\`\`\`

## コードブロック

言語名を指定するとシンタックスハイライトが適用されます。

\`\`\`\`markdown
\\\`\\\`\\\`javascript
const greeting = "Hello, scripta!";
console.log(greeting);
\\\`\\\`\\\`
\`\`\`\`

## Wiki Links

\`[[ファイル名]]\` でワークスペース内の別ファイルへリンクできます。

\`\`\`markdown
[[meeting-notes]]           → meeting-notes.md を開く
[[docs/api-design|API設計]]  → 表示テキストを指定
\`\`\`

入力中に候補が表示され、ファジー検索で素早くファイルを見つけられます。

## 数式（KaTeX）

インライン数式: \`$E = mc^2$\` → $E = mc^2$

ディスプレイ数式:

\`\`\`markdown
$$
\\\\int_{-\\\\infty}^{\\\\infty} e^{-x^2} dx = \\\\sqrt{\\\\pi}
$$
\`\`\`

$$
\\\\int_{-\\\\infty}^{\\\\infty} e^{-x^2} dx = \\\\sqrt{\\\\pi}
$$

## Mermaid ダイアグラム

フローチャート、シーケンス図などを Markdown 内に記述できます。

\`\`\`\`markdown
\\\`\\\`\\\`mermaid
graph LR
    A[企画] --> B[設計]
    B --> C[実装]
    C --> D[テスト]
    D --> E[リリース]
\\\`\\\`\\\`
\`\`\`\`

\`\`\`mermaid
graph LR
    A[企画] --> B[設計]
    B --> C[実装]
    C --> D[テスト]
    D --> E[リリース]
\`\`\`

## エクスポート

メニューまたは \`Cmd+Shift+E\` で以下の形式にエクスポートできます:

- **HTML** — テーマ（ライト/ダーク/システム）を選択可能
- **PDF** — 見出しレベルでの改ページに対応
- **プロンプト** — AI への指示用テンプレートとして出力（\`.scripta/prompt-template.md\` でカスタマイズ可能）

## キーボードショートカット

| ショートカット | 機能 |
|:-------------|:-----|
| \`Cmd+P\` | ファイル検索（コマンドパレット） |
| \`Cmd+Shift+F\` | 全文検索 |
| \`Cmd+F\` | ファイル内検索 |
| \`Cmd+H\` | ファイル内置換 |
| \`Cmd+B\` | サイドバー表示切替 |
| \`Cmd+,\` | 設定 |
| \`Cmd+Shift+E\` | エクスポート |
| \`F1\` | ヘルプ |
`;

// --- Template definitions ---

export interface TemplateDefinition {
	name: string;
	getPath: (workspacePath: string) => string;
	getContent: () => string;
}

/**
 * テンプレートファイルの定義一覧を返す。
 * SetupWizardDialog / SettingsDialog 両方から参照し、定義の重複を防ぐ。
 * getDefaultPromptTemplate は循環参照を避けるため引数で受け取る。
 */
export function getTemplateDefinitions(getPromptContent: () => string): TemplateDefinition[] {
	return [
		{ name: "README.md", getPath: getReadmeTemplatePath, getContent: () => README_TEMPLATE },
		{ name: "CLAUDE.md", getPath: getClaudeMdTemplatePath, getContent: () => CLAUDE_MD_TEMPLATE },
		{ name: ".gitignore", getPath: getGitignorePath, getContent: () => GITIGNORE_TEMPLATE },
		{
			name: "syntax-guide.md",
			getPath: getSyntaxGuidePath,
			getContent: () => SYNTAX_GUIDE_TEMPLATE,
		},
		{
			name: "prompt-template.md",
			getPath: getScriptaPromptTemplatePath,
			getContent: getPromptContent,
		},
	];
}
