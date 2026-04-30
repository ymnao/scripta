export const SAMPLE_MARKDOWN = `# Stage 0b 検証用デモ

これは **Stage 0b** の検証用 _DemoView_ です。Live Preview の各デコレーションが Chromium 上で破綻なく描画されるかを目視で確認します。

\`?demo=1\` URL クエリで表示されます。Stage 1 完了時に削除される一時コードです。

## 見出し（H1〜H6）

# H1 見出し
## H2 見出し
### H3 見出し
#### H4 見出し
##### H5 見出し
###### H6 見出し

## 強調

**太字**、_斜体_、~~取り消し線~~、\`インラインコード\`。

太字と斜体の組み合わせ: **太字の中に _斜体_ が入る**。

## リンク

[Anthropic](https://www.anthropic.com) は AI 安全性の研究組織です。

リンクカード（OGP は Stage 0b では固定値ダミー）:

[https://www.anthropic.com](https://www.anthropic.com)

## 画像

![Anthropic favicon](https://www.anthropic.com/favicon.ico)

## コードブロック

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

\`\`\`python
def greet(name: str) -> str:
    return f"Hello, {name}!"
\`\`\`

## リスト

### 順序リスト

1. 一つ目
2. 二つ目
3. 三つ目

### 非順序リスト

- 一つ目
- 二つ目
  - ネスト
  - 深いネスト
- 三つ目

### タスクリスト

- [x] 完了したタスク
- [ ] 未完了のタスク
- [ ] もう一つの未完了

## 引用

> これは引用です。
> 複数行にわたる引用も書けます。
>
> > ネストされた引用。

## 水平線

---

## テーブル

| 名前 | 役割 | 状態 |
| --- | --- | --- |
| Alice | Frontend | Active |
| Bob | Backend | Active |
| Carol | Designer | Inactive |

## 数式（KaTeX）

インライン数式: $E = mc^2$ がアインシュタインの質量エネルギー等価式です。

ブロック数式:

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

## Mermaid

\`\`\`mermaid
graph TD
  A[Start] --> B{Decision?}
  B -->|Yes| C[Action 1]
  B -->|No| D[Action 2]
  C --> E[End]
  D --> E
\`\`\`

## Wikilink

[[Stage 0b]] と [[Live Preview]] のリンク（未解決として表示されます）。
`;
