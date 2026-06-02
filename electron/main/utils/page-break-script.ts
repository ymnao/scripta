/**
 * PDF 改ページ補正スクリプト (#93) — hybrid CSS + JS アプローチ。
 *
 * # 背景
 *
 * Chromium の `break-inside: avoid` を wrapper 要素（`<section>` / `<div>` 等）に
 * 当てても、wrapper 全体を次ページへ送る挙動には **ならない**。子要素（LI 等）
 * それぞれが `break-inside: avoid` を持っている場合、Chromium は「子要素間の
 * 境界で break」を選択し、wrapper の avoid 要件は『子レベルで尊重した』と
 * みなして wrapper の中割れを許容してしまう（known issue: chromium #601033,
 * puppeteer #6366, 多数の bug report）。
 *
 * # 解決策
 *
 * このスクリプトが「実 layout で wrapper がページ境界をまたぐかどうか」を
 * 測定し、またぐものに `style.breakBefore = 'page'` を **明示的に inline style で
 * 注入** することで、Chromium に「この section の前で必ず改ページ」を強制する。
 * 明示的な `break-before` は Chromium が確実に尊重する。
 *
 * # 測定精度の確保と drift 対策
 *
 * screen layout と print layout は CSS が同じでも完全一致しない（margin collapse、
 * font metrics、KaTeX/Mermaid のサブピクセル丸めなど）。section 高さで drift が
 * 数 mm〜数十 mm の誤差を持つ場合があり、「screen で測ると収まるが print では
 * 収まらない」境界ケースが発生し得る。
 *
 * 対策: `SAFETY_BUFFER_RATIO`（ページ高さの 10%、A4 で約 25mm）を section の必要
 * 高さに加算して判定。drift を吸収しつつ、過度な force-break で空白を増やしすぎない
 * バランス点。
 *
 * # 診断
 *
 * 走査結果を JSON で return し、呼び出し側 (pdf.ts) が `console.log` で
 * メインプロセス stderr へ書き出す。「script が走ったか / 何セクション検出されたか /
 * 何セクション force-break したか」をユーザが pnpm dev のターミナルで確認できる。
 */

/**
 * `executeJavaScript` で実行する文字列を返す。pure function (テスト容易性のため)。
 * 戻り値は `{ count, broken, errors }` を含む JSON 文字列。
 */
export function buildSectionBreakScript(): string {
	return `(function() {
  var result = { count: 0, broken: 0, errors: [] };
  try {
    var sections = document.querySelectorAll('.pdf-section-keep');
    result.count = sections.length;
    if (sections.length === 0) return JSON.stringify(result);

    // ページ高さ (A4 - 上下 20mm margin = 257mm) を実測。
    // CSS zoom 適用時、getBoundingClientRect() は zoom 後の値を返す。
    var zoom = parseFloat(document.body.style.zoom) || 1;
    var ruler = document.createElement('div');
    ruler.style.cssText = 'position:absolute;visibility:hidden;width:0;height:257mm;';
    document.body.appendChild(ruler);
    var pageHeight = ruler.getBoundingClientRect().height;
    document.body.removeChild(ruler);
    if (pageHeight <= 0) {
      result.errors.push('pageHeight measurement <= 0');
      return JSON.stringify(result);
    }

    // 20% safety buffer (≈51mm @ A4)。screen と print の layout drift（KaTeX 行送り
     // 差、margin collapse、リスト padding 差等で section 高さが数mm〜数十mm 食い違う）
     // を吸収する。10% で不足ケースが報告されたため拡大 (#93)。
    var safetyBuffer = pageHeight * 0.20;

    // body を印刷幅 (170mm) に揃えてから measure。screen 幅と print 幅で
    // テキスト折り返しが変わると section 高さが drift するため。
    var origPadding = document.body.style.padding;
    var origWidth = document.body.style.width;
    var origMaxWidth = document.body.style.maxWidth;
    document.body.style.padding = '0';
    var pw = (170 / zoom) + 'mm';
    document.body.style.width = pw;
    document.body.style.maxWidth = pw;
    var styleEl = document.createElement('style');
    styleEl.textContent = 'pre { white-space: pre-wrap !important; word-wrap: break-word !important; }';
    document.head.appendChild(styleEl);
    document.body.offsetHeight; // 強制 reflow

    try {
      var children = Array.prototype.slice.call(document.body.children);
      var virtualY = 0;

      for (var i = 0; i < children.length; i++) {
        var item = children[i];
        var rect = item.getBoundingClientRect();
        var height = rect.bottom - rect.top;
        if (height < 0) height = 0;

        // 著者マーカー (hr.pdf-pagebreak): virtualY を次ページ頭へジャンプ
        var isMarker =
          item.tagName === 'HR' &&
          item.classList &&
          item.classList.contains('pdf-pagebreak');
        if (isMarker && virtualY > 0) {
          var inPageMarker = virtualY % pageHeight;
          if (inPageMarker > 0) virtualY += pageHeight - inPageMarker;
          virtualY += height;
          continue;
        }

        // .pdf-section-keep がページ境界をまたぐ場合の処理
        if (item.classList && item.classList.contains('pdf-section-keep') && height > 0) {
          var inPage = virtualY % pageHeight;
          var remaining = pageHeight - inPage;
          // 判定: section が現ページ残量に収まらない (drift buffer 加算)
          //      && section 全体が 1 ページに収まる (収まらないなら force しても無意味)
          //      && 既にページ途中 (page 頭での force は no-op)
          if (
            (height + safetyBuffer) > remaining &&
            height <= pageHeight &&
            inPage > 0
          ) {
            item.style.breakBefore = 'page';
            item.style.pageBreakBefore = 'always';
            virtualY += remaining; // 次ページ頭まで進める
            result.broken++;
          }
        }

        virtualY += height;
      }
    } finally {
      document.head.removeChild(styleEl);
      document.body.style.padding = origPadding;
      document.body.style.width = origWidth;
      document.body.style.maxWidth = origMaxWidth;
    }
  } catch (e) {
    result.errors.push(String(e && e.message ? e.message : e));
  }
  return JSON.stringify(result);
})();`;
}
