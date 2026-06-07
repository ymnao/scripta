#!/usr/bin/env node
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

const ROOT = join(__dirname, "..");
const KATEX_CSS = join(ROOT, "node_modules/katex/dist/katex.min.css");
const KATEX_DIST = dirname(KATEX_CSS);
const OUT_FILE = join(ROOT, "src/generated/katex-inline-css.ts");

let css = readFileSync(KATEX_CSS, "utf8");

css = css.replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (_match, fileName) => {
	const base64 = readFileSync(join(KATEX_DIST, "fonts", fileName)).toString("base64");
	return `url(data:font/woff2;base64,${base64})`;
});

css = css.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");

if (/url\(fonts\//.test(css) || /https?:\/\//.test(css)) {
	console.error("[generate-katex-css] ERROR: 変換後の CSS に外部参照が残っています");
	process.exit(1);
}

mkdirSync(dirname(OUT_FILE), { recursive: true });

const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

writeFileSync(OUT_FILE, `export const katexInlineCss = \`${escaped}\`;\n`);

console.log(`[generate-katex-css] ${OUT_FILE} (${(css.length / 1024).toFixed(0)} KB)`);
