/**
 * PDF 改ページ補正スクリプト (#93) — main 内で完結する hybrid アプローチ。
 *
 * # 背景
 *
 * Chromium の `break-inside: avoid` を wrapper 要素 (`<section>` / `<div>`) に当てても
 * wrapper 全体を次ページへ送る挙動には **ならない**。子要素 (LI 等) が break-inside:
 * avoid を持つと Chromium は子要素間で break する経路を選び、wrapper の avoid 要件は
 * 「子レベルで尊重」とみなして wrapper 中割れを許容してしまう (chromium #601033 /
 * puppeteer #6366 等の known issue)。
 *
 * # 解決策
 *
 * 1. 印刷直前（fonts.ready + idle 後 / printToPDF 直前）に main から executeJavaScript
 *    でこのスクリプトを実行する。
 * 2. 必要なら `<section class="pdf-section-keep">` を DOM 操作で自前 wrap する
 *    （renderer 側で wrap 済みなら skip）。renderer のコード反映状態に左右されない。
 * 3. 自前で必要な CSS (`break-inside: avoid-page`) も style 要素経由で注入。
 * 4. 各 section の実 layout 位置を測定し、ページ境界をまたぐものに inline
 *    `style.breakBefore = 'page'` を強制注入。
 *
 * # 測定精度の確保
 *
 * - body width を印刷幅 (170mm) に揃え、`pre` を pre-wrap にして印刷折り返しを再現
 * - safety buffer 20% を section 高さに加算して screen ⇔ print の layout drift を吸収
 *
 * # 診断
 *
 * 走査結果を JSON で return:
 *   - rendererWrapped: 既存の wrap が存在したか
 *   - h2Count: body 直下の h2 数（自前 wrap 判断用）
 *   - count: 最終的に検出した .pdf-section-keep 数
 *   - broken: break-before を注入した section 数
 *   - errors: 例外メッセージ
 *
 * 呼び出し側 (pdf.ts) が console.log でメインプロセス stderr へ書き出し、ユーザが
 * pnpm dev のターミナルで動作確認できる。
 */

/**
 * `executeJavaScript` で実行する文字列を返す。pure function (テスト容易性のため)。
 * smartLevel: wrap 対象見出しレベル (default 2 = h2)。
 */
export function buildSectionBreakScript(smartLevel: 1 | 2 | 3 = 2): string {
	return `(function() {
  var result = {
    rendererWrapped: false,
    h2Count: 0,
    count: 0,
    broken: 0,
    errors: []
  };

  try {
    var SMART_LEVEL = ${smartLevel};

    // 既存 wrap (renderer 側で wrapSectionsInHtml が走っていれば存在)
    var existing = document.querySelectorAll('.pdf-section-keep');
    result.rendererWrapped = existing.length > 0;
    result.h2Count = document.querySelectorAll('body > h' + SMART_LEVEL).length;

    // 自前 wrap (renderer が古い / smart=false で wrap が走っていない場合の保険)
    if (!result.rendererWrapped && result.h2Count > 0) {
      // body 直下の対象見出しを集める
      var headings = Array.prototype.slice.call(
        document.querySelectorAll('body > h' + SMART_LEVEL)
      );
      // 末尾から処理（DOM 操作中の collection 不整合を避ける）
      for (var hi = headings.length - 1; hi >= 0; hi--) {
        var startEl = headings[hi];
        // 終端: 次の同位以上の見出し or null
        var endEl = startEl.nextSibling;
        while (endEl) {
          if (endEl.nodeType === 1 && /^H[1-6]$/.test(endEl.tagName)) {
            var lvl = parseInt(endEl.tagName.charAt(1), 10);
            if (lvl <= SMART_LEVEL) break;
          }
          endEl = endEl.nextSibling;
        }
        // startEl から endEl の手前までを section に移動
        var section = document.createElement('section');
        section.className = 'pdf-section-keep';
        startEl.parentNode.insertBefore(section, startEl);
        var cur = startEl;
        while (cur && cur !== endEl) {
          var next = cur.nextSibling;
          section.appendChild(cur);
          cur = next;
        }
      }
    }

    // 必要な CSS を inject (renderer が古いと .pdf-section-keep 用の break-inside CSS が無いため)
    var styleEl = document.createElement('style');
    styleEl.textContent = '@media print { .pdf-section-keep { break-inside: avoid-page; page-break-inside: avoid; } } pre.pdf-section-measure { white-space: pre-wrap !important; word-wrap: break-word !important; }';
    document.head.appendChild(styleEl);

    // section 検出
    var sections = document.querySelectorAll('.pdf-section-keep');
    result.count = sections.length;
    if (sections.length === 0) {
      document.head.removeChild(styleEl);
      return JSON.stringify(result);
    }

    // ページ高さ (A4 - 上下 20mm margin = 257mm)
    var zoom = parseFloat(document.body.style.zoom) || 1;
    var ruler = document.createElement('div');
    ruler.style.cssText = 'position:absolute;visibility:hidden;width:0;height:257mm;';
    document.body.appendChild(ruler);
    var pageHeight = ruler.getBoundingClientRect().height;
    document.body.removeChild(ruler);
    if (pageHeight <= 0) {
      result.errors.push('pageHeight measurement <= 0');
      document.head.removeChild(styleEl);
      return JSON.stringify(result);
    }

    // 20% safety buffer (≈51mm @ A4) で screen ⇔ print の layout drift を吸収
    var safetyBuffer = pageHeight * 0.20;

    // body を印刷幅 (170mm) に揃えてから measure
    var origPadding = document.body.style.padding;
    var origWidth = document.body.style.width;
    var origMaxWidth = document.body.style.maxWidth;
    document.body.style.padding = '0';
    var pw = (170 / zoom) + 'mm';
    document.body.style.width = pw;
    document.body.style.maxWidth = pw;
    var measureStyle = document.createElement('style');
    measureStyle.textContent = 'pre { white-space: pre-wrap !important; word-wrap: break-word !important; }';
    document.head.appendChild(measureStyle);
    document.body.offsetHeight; // 強制 reflow

    try {
      var children = Array.prototype.slice.call(document.body.children);
      var virtualY = 0;

      for (var i = 0; i < children.length; i++) {
        var item = children[i];
        var rect = item.getBoundingClientRect();
        var height = rect.bottom - rect.top;
        if (height < 0) height = 0;

        // pagebreak 著者マーカー
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

        // .pdf-section-keep のページ境界またぎ判定
        if (item.classList && item.classList.contains('pdf-section-keep') && height > 0) {
          var inPage = virtualY % pageHeight;
          var remaining = pageHeight - inPage;
          if (
            (height + safetyBuffer) > remaining &&
            height <= pageHeight &&
            inPage > 0
          ) {
            item.style.breakBefore = 'page';
            item.style.pageBreakBefore = 'always';
            virtualY += remaining;
            result.broken++;
          }
        }

        virtualY += height;
      }
    } finally {
      document.head.removeChild(measureStyle);
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
