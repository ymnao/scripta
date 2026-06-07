#!/usr/bin/env node
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

const ROOT = join(__dirname, "..");
const KATEX_DIST = join(ROOT, "node_modules/katex/dist");
const OUT_FILE = join(ROOT, "src/generated/katex-inline-css.ts");

let css = readFileSync(join(KATEX_DIST, "katex.min.css"), "utf8");

// woff2 font を data: URI に inline 化
css = css.replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (_match, fileName) => {
	const fontPath = join(KATEX_DIST, "fonts", fileName);
	const base64 = readFileSync(fontPath).toString("base64");
	return `url(data:font/woff2;base64,${base64})`;
});

// woff / ttf fallback を除去（woff2 は全モダンブラウザ対応済み）
css = css.replace(/,url\(fonts\/[\w-]+\.woff\) format\("woff"\)/g, "");
css = css.replace(/,url\(fonts\/[\w-]+\.ttf\) format\("truetype"\)/g, "");

mkdirSync(dirname(OUT_FILE), { recursive: true });

const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

writeFileSync(OUT_FILE, `export const katexInlineCss = \`${escaped}\`;\n`);

console.log(`[generate-katex-css] ${OUT_FILE} (${(css.length / 1024).toFixed(0)} KB)`);
