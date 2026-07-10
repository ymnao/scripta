/**
 * プロンプトエクスポート用のデフォルトテンプレート。
 *
 * `export.ts` 本体（katex-inline-css・mermaid 等の重量級依存を静的 import する）から
 * 分離している。SettingsDialog / SetupWizardDialog はテンプレート定義一覧を表示するために
 * このデフォルト値だけを必要とし、export 実行ロジック一式は不要なため、ここを切り出すことで
 * 初期チャンクに export.ts の依存が引き込まれるのを防ぐ（#301）。
 */
export function getDefaultPromptTemplate(): string {
	return `# HTML変換プロンプト

以下のMarkdownコンテンツを、美しく整形されたHTMLファイルに変換してください。

## 要件

- 完全なHTMLドキュメント（DOCTYPE、head、body）
- スタイルは原則インラインCSSで記述
- レスポンシブデザイン対応
- @media (prefers-color-scheme: dark) によるダーク/ライト自動切替
- 数式は KaTeX を用い、CSS と font は外部ネットワーク不要な形式（インライン CSS + data URL font）で埋め込む
- コードブロックはモノスペースフォント + 背景色付き
- テーブルは罫線付き
- @media print ルールを含む

## ドキュメントタイトル

{title}

## Markdownコンテンツ

{content}
`;
}
