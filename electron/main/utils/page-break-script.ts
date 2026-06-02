/**
 * PDF 改ページ補正スクリプト (#93) — table-row hack (v4)。
 *
 * # 設計の経緯
 *
 * v1: CSS `break-inside: avoid` を `<section>` wrapper に → 中割れ (Chromium が子要素間で break)
 * v2: CSS `break-inside: avoid-page` を `<section>` に動的 inject → 各 section が独立 page に
 *     overcaution （無駄空白だらけ、user 報告で「逆にとんでもないこと」）
 *
 * **v4 (current)**: **Table-row hack**。Chromium は `<table><tr>` を atomic break unit として
 *   扱い、「行が現ページに入るなら入れる、入らないなら次ページに送る」を確実に実装する。
 *   wrapper の break-inside hint よりはるかに信頼できる手法（CSS Paged Media の community で
 *   bootstrap や paged.js も推奨）。
 *
 * # 設計
 *
 * 1. document の見出し分布を自動検出
 * 2. 既存の `.pdf-section-keep` (section wrap、renderer 側で作成されたもの) を
 *    `<table class="pdf-section-keep"><tbody><tr><td>...</td></tr></tbody></table>` に変換
 * 3. 既存がなければ smart level の見出しを上記 table 構造で直接 wrap
 * 4. table 装飾 CSS を inject (見た目を block と同じにする: width 100%, border 0, padding 0)
 * 5. 既存の `.pdf-section-keep { break-inside: ... }` rule を `auto !important` で override
 *    (renderer の stale CSS が残っている場合の保険)
 *
 * # 設計の利点
 *
 * - table row の atomic 性は Chromium で **長年安定**。break-inside hint と違って quirk 無し
 * - measurement drift の影響を受けない (Chromium が実 layout で決定)
 * - 中割れも overcaution も起きない
 *
 * # 診断
 *
 * 走査結果を JSON で return: rendererWrapped / headingCounts / smartLevelUsed /
 * count / converted (table 化した数) / errors。
 */

/**
 * `executeJavaScript` で実行する文字列を返す。pure function (テスト容易性のため)。
 */
export function buildSectionBreakScript(): string {
	return `(function() {
  var result = {
    rendererWrapped: false,
    headingCounts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    smartLevelUsed: null,
    count: 0,
    converted: 0,
    errors: []
  };

  try {
    // 既存の wrap (renderer 側 wrapSectionsInHtml が走っていれば存在)
    var existing = document.querySelectorAll('.pdf-section-keep');
    result.rendererWrapped = existing.length > 0;

    for (var lvl = 1; lvl <= 6; lvl++) {
      result.headingCounts['h' + lvl] =
        document.querySelectorAll('body > h' + lvl).length;
    }

    // smart level 自動検出
    var smartLevel = null;
    var hc = result.headingCounts;
    if (hc.h2 >= 2) smartLevel = 2;
    else if (hc.h3 >= 2) smartLevel = 3;
    else if (hc.h1 >= 2) smartLevel = 1;
    else if (hc.h4 >= 2) smartLevel = 4;
    result.smartLevelUsed = smartLevel;

    // table 装飾 CSS と、既存 break-inside rule の override を inject。
    // !important で renderer 側 stale CSS の .pdf-section-keep break-inside:avoid-page を
    // 無効化する（overcaution の元）。
    var styleEl = document.createElement('style');
    styleEl.textContent = [
      '.pdf-section-keep {',
      '  break-inside: auto !important;',
      '  page-break-inside: auto !important;',
      '}',
      'table.pdf-section-keep {',
      '  width: 100%;',
      '  border-collapse: collapse;',
      '  margin: 0;',
      '  border: 0;',
      '}',
      'table.pdf-section-keep > tbody > tr > td {',
      '  padding: 0;',
      '  border: 0;',
      '  vertical-align: top;',
      '}',
      // table row は atomic break unit (Chromium の table layout の自然な挙動)
      // ここで明示的に書く必要は無いが、保険として
      'table.pdf-section-keep > tbody > tr {',
      '  break-inside: avoid;',
      '  page-break-inside: avoid;',
      '}'
    ].join('\\n');
    document.head.appendChild(styleEl);

    function wrapAsTable(elements) {
      // 与えられた element 群を <table.pdf-section-keep><tbody><tr><td>...</td></tr></tbody></table>
      // に移動する。最初の element の位置に挿入。
      if (elements.length === 0) return null;
      var first = elements[0];
      var table = document.createElement('table');
      table.className = 'pdf-section-keep';
      var tbody = document.createElement('tbody');
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      table.appendChild(tbody);
      tbody.appendChild(tr);
      tr.appendChild(td);
      first.parentNode.insertBefore(table, first);
      for (var k = 0; k < elements.length; k++) {
        td.appendChild(elements[k]);
      }
      return table;
    }

    // 既存 section wrap を table に置換
    if (result.rendererWrapped) {
      var existingArr = Array.prototype.slice.call(existing);
      for (var ei = 0; ei < existingArr.length; ei++) {
        var sec = existingArr[ei];
        if (sec.tagName === 'TABLE') continue; // already table
        // section の子要素全部を取り出して table 化
        var inner = [];
        var c = sec.firstChild;
        while (c) {
          var nx = c.nextSibling;
          if (c.nodeType === 1) inner.push(c);
          c = nx;
        }
        if (inner.length === 0) continue;
        // section の位置に table を挿入してから section を削除
        var table = document.createElement('table');
        table.className = 'pdf-section-keep';
        var tbody = document.createElement('tbody');
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        table.appendChild(tbody);
        tbody.appendChild(tr);
        tr.appendChild(td);
        sec.parentNode.insertBefore(table, sec);
        for (var ii = 0; ii < inner.length; ii++) td.appendChild(inner[ii]);
        sec.parentNode.removeChild(sec);
        result.converted++;
      }
    } else if (smartLevel !== null) {
      // body 直下に対象 heading が複数 → table で wrap
      var headings = Array.prototype.slice.call(
        document.querySelectorAll('body > h' + smartLevel)
      );
      // 末尾から処理 (DOM 操作中の collection 不整合回避)
      for (var hi = headings.length - 1; hi >= 0; hi--) {
        var startEl = headings[hi];
        // 終端: 次の同位以上見出し or null
        var endEl = startEl.nextSibling;
        var inner = [startEl];
        var cur = startEl.nextSibling;
        while (cur) {
          if (cur.nodeType === 1 && /^H[1-6]$/.test(cur.tagName)) {
            var lvl2 = parseInt(cur.tagName.charAt(1), 10);
            if (lvl2 <= smartLevel) break;
          }
          if (cur.nodeType === 1) inner.push(cur);
          cur = cur.nextSibling;
        }
        wrapAsTable(inner);
        result.converted++;
      }
    }

    var finalCount = document.querySelectorAll('table.pdf-section-keep').length;
    result.count = finalCount;
  } catch (e) {
    result.errors.push(String(e && e.message ? e.message : e));
  }
  return JSON.stringify(result);
})();`;
}
