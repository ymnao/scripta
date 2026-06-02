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
 * 例えば「H2 + LI + LI + LI」というセクションで、LI3 のサイズだけページ末尾を
 * 超える場合、Chromium は LI2 と LI3 の間で break して LI3 を次ページに送る。
 * wrapper の break-inside: avoid は「LI 自身は分割しない」点では尊重されるが、
 * **セクション全体を次ページに送るには至らない**。
 *
 * # 解決策
 *
 * このスクリプトが「実 layout で wrapper がページ境界をまたぐかどうか」を
 * 測定し、またぐものに `style.breakBefore = 'page'` / `pageBreakBefore = 'always'`
 * を **明示的に inline style で注入** することで、Chromium に「この section の
 * 前で必ず改ページ」を強制する。明示的な `break-before` は Chromium が確実に
 * 尊重する。
 *
 * # 測定精度の確保
 *
 * - script 内で body.width を印刷幅 (170mm) に揃え、`pre` を pre-wrap にして
 *   印刷時のテキスト折り返しを再現してから測定。screen 幅 (800px) のままだと
 *   テキスト wrap が違って section 高さが drift するため。
 * - body 直下の children を順に走査し、virtualY を累積。`.pdf-section-keep`
 *   要素が現ページ残量に収まらず、かつ 1 ページに収まるなら break-before 注入。
 * - body 直下の HR (`<hr class="pdf-pagebreak">`) は明示的に検出して virtualY を
 *   次ページ頭にジャンプ（@media print の force-break を screen 測定で再現するため）。
 */

/**
 * `executeJavaScript` で実行する文字列を返す。pure function (テスト容易性のため)。
 */
export function buildSectionBreakScript(): string {
	return `(function() {
  var sections = document.querySelectorAll('.pdf-section-keep');
  if (sections.length === 0) return;

  // ページ高さ (A4 - 上下 20mm margin = 257mm) を実測。
  // CSS zoom 適用時、getBoundingClientRect() は zoom 後の値を返す。
  var zoom = parseFloat(document.body.style.zoom) || 1;
  var ruler = document.createElement('div');
  ruler.style.cssText = 'position:absolute;visibility:hidden;width:0;height:257mm;';
  document.body.appendChild(ruler);
  var pageHeight = ruler.getBoundingClientRect().height;
  document.body.removeChild(ruler);
  if (pageHeight <= 0) return;

  // body を印刷幅 (170mm) に揃えてから measure。screen 幅と print 幅で
  // テキスト折り返しが変わると section 高さが drift するため。
  var origPadding = document.body.style.padding;
  var origWidth = document.body.style.width;
  var origMaxWidth = document.body.style.maxWidth;
  document.body.style.padding = '0';
  var pw = (170 / zoom) + 'mm';
  document.body.style.width = pw;
  document.body.style.maxWidth = pw;
  // pre も印刷時の wrap モードに合わせる
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

      // pagebreak 著者マーカー (hr.pdf-pagebreak) は次ページ頭へジャンプ
      // CSS @media print の break-before:page を screen 測定で再現する
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
        // section がページ残量に収まらない && 1 ページ全体には収まる && 既にページ途中
        // → break-before:page を強制注入して次ページ先頭から開始させる
        // 1 ページに収まらない (=巨大 section) 時は強制しても無意味なので skip
        if (height > remaining && height <= pageHeight && inPage > 0) {
          item.style.breakBefore = 'page';
          item.style.pageBreakBefore = 'always';
          virtualY += remaining; // 次ページ頭まで進める
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
})();`;
}
