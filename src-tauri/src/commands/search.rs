use super::file::resolve_path;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub file_path: String,
    pub line_number: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
}

/// Build a byte-offset mapping from the lowercased string back to the original.
///
/// Returns a Vec where `result[i]` is the byte offset in the original string
/// that corresponds to byte offset `i` in `original.to_lowercase()`.
/// An extra sentinel entry is appended for the end-of-string position.
fn build_lower_to_orig_map(original: &str) -> Vec<usize> {
    let mut map = Vec::new();
    let mut orig_offset = 0;
    for ch in original.chars() {
        let orig_len = ch.len_utf8();
        let mut buf = [0u8; 4];
        let lower_len: usize = ch
            .to_lowercase()
            .map(|lc| lc.encode_utf8(&mut buf).len())
            .sum();
        for _ in 0..lower_len {
            map.push(orig_offset);
        }
        orig_offset += orig_len;
    }
    map.push(orig_offset);
    map
}

/// Build a mapping from byte offsets to cumulative UTF-16 code unit counts.
///
/// `result[byte_offset]` gives the number of UTF-16 code units before that byte offset.
/// Only valid at char boundaries; intermediate bytes share the preceding boundary's value.
/// An extra sentinel entry is appended for the end-of-string position.
fn build_byte_to_utf16_map(s: &str) -> Vec<usize> {
    let mut map = Vec::with_capacity(s.len() + 1);
    let mut utf16_count = 0;
    for ch in s.chars() {
        let byte_len = ch.len_utf8();
        map.push(utf16_count);
        for _ in 1..byte_len {
            map.push(utf16_count);
        }
        utf16_count += ch.len_utf16();
    }
    map.push(utf16_count);
    map
}

fn collect_md_files(dir: &Path, results: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry_result in entries {
        let entry = entry_result.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            collect_md_files(&entry.path(), results)?;
        } else if name.ends_with(".md") {
            results.push(entry.path().to_string_lossy().to_string());
        }
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn search_files(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let resolved = resolve_path(&workspace_path)?;
    let mut md_files = Vec::new();
    collect_md_files(&resolved, &mut md_files)?;
    md_files.sort();

    let case_sensitive = case_sensitive.unwrap_or(false);
    let query_search = if case_sensitive {
        query.clone()
    } else {
        query.to_lowercase()
    };
    let mut results = Vec::new();

    for file_path in &md_files {
        let content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (line_idx, line) in content.lines().enumerate() {
            // Precompute byte-offset → UTF-16 offset map once per line
            let byte_to_utf16 = build_byte_to_utf16_map(line);

            if case_sensitive {
                let mut search_start = 0;
                while let Some(pos) = line[search_start..].find(&query_search) {
                    let byte_start = search_start + pos;
                    let byte_end = byte_start + query_search.len();
                    let utf16_start = byte_to_utf16[byte_start];
                    let utf16_end = byte_to_utf16[byte_end];
                    results.push(SearchResult {
                        file_path: file_path.clone(),
                        line_number: line_idx + 1,
                        line_content: line.to_string(),
                        match_start: utf16_start,
                        match_end: utf16_end,
                    });
                    search_start = byte_end;
                }
            } else {
                // Build byte-offset mapping: lowercased → original.
                // to_lowercase() can change char count (e.g. İ → i\u{0307}),
                // so we map positions back to the original string for correct offsets.
                let line_lower = line.to_lowercase();
                let lower_to_orig = build_lower_to_orig_map(line);

                let mut search_start = 0;
                while let Some(pos) = line_lower[search_start..].find(&query_search) {
                    let lower_byte_start = search_start + pos;
                    let lower_byte_end = lower_byte_start + query_search.len();
                    let orig_byte_start = lower_to_orig[lower_byte_start];
                    let orig_byte_end = lower_to_orig[lower_byte_end];
                    let utf16_start = byte_to_utf16[orig_byte_start];
                    let utf16_end = byte_to_utf16[orig_byte_end];
                    results.push(SearchResult {
                        file_path: file_path.clone(),
                        line_number: line_idx + 1,
                        line_content: line.to_string(),
                        match_start: utf16_start,
                        match_end: utf16_end,
                    });
                    search_start = lower_byte_end;
                }
            }
        }
    }

    Ok(results)
}

fn fuzzy_match(query: &str, target: &str) -> bool {
    let target_lower = target.to_lowercase();
    let mut target_chars = target_lower.chars();
    for query_char in query.to_lowercase().chars() {
        let mut found = false;
        for target_char in target_chars.by_ref() {
            if target_char == query_char {
                found = true;
                break;
            }
        }
        if !found {
            return false;
        }
    }
    true
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn search_filenames(workspace_path: String, query: String) -> Result<Vec<String>, String> {
    let resolved = resolve_path(&workspace_path)?;
    let mut md_files = Vec::new();
    collect_md_files(&resolved, &mut md_files)?;
    md_files.sort();

    if query.is_empty() {
        return Ok(md_files);
    }

    let matched: Vec<String> = md_files
        .into_iter()
        .filter(|path| {
            let name = Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default();
            fuzzy_match(&query, &name)
        })
        .collect();

    Ok(matched)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkReference {
    pub file_path: String,
    pub line_number: usize,
    /// 1-based byte offset of `[[` in the line (used as unique key, not character column)
    pub byte_offset: usize,
    pub line_content: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedWikilink {
    pub page_name: String,
    pub references: Vec<WikilinkReference>,
}

/// Check if a page name contains path traversal characters
fn is_path_traversal(name: &str) -> bool {
    name.contains('/')
        || name.contains('\\')
        || name == "."
        || name.contains("..")
}

/// Extract wikilink inner contents from a line (returns the text between [[ and ]])
fn extract_wikilinks_from_line(line: &str) -> Vec<(&str, usize)> {
    let mut results = Vec::new();
    let mut search_start = 0;
    while let Some(open_pos) = line[search_start..].find("[[") {
        let abs_open = search_start + open_pos;
        let inner_start = abs_open + 2;
        if inner_start >= line.len() {
            break;
        }
        if let Some(close_pos) = line[inner_start..].find("]]") {
            let inner = &line[inner_start..inner_start + close_pos];
            if !inner.is_empty() {
                results.push((inner, abs_open + 1));
            }
            search_start = inner_start + close_pos + 2;
        } else {
            break;
        }
    }
    results
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn scan_unresolved_wikilinks(
    workspace_path: String,
) -> Result<Vec<UnresolvedWikilink>, String> {
    let resolved = resolve_path(&workspace_path)?;
    let mut md_files = Vec::new();
    collect_md_files(&resolved, &mut md_files)?;
    md_files.sort();

    // Build set of existing file basenames (NFC normalized, .md removed)
    let existing_pages: HashSet<String> = md_files
        .iter()
        .filter_map(|path| {
            let name = Path::new(path).file_name()?.to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".md") {
                return None;
            }
            let basename = &name[..name.len() - 3];
            Some(basename.nfc().collect::<String>())
        })
        .collect();

    let mut unresolved_map: HashMap<String, Vec<WikilinkReference>> = HashMap::new();

    for file_path in &md_files {
        let content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let lines: Vec<&str> = content.lines().collect();
        let mut in_code_block = false;

        for (line_idx, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();

            // Check for fenced code block boundaries
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_code_block = !in_code_block;
                continue;
            }
            if in_code_block {
                continue;
            }

            let wikilinks = extract_wikilinks_from_line(line);
            for (inner, byte_offset) in wikilinks {
                // Extract page name (handle [[page|display]])
                let page = match inner.find('|') {
                    Some(pipe_idx) => &inner[..pipe_idx],
                    None => inner,
                };

                if page.is_empty() || is_path_traversal(page) {
                    continue;
                }

                // NFC normalize and strip .md
                let stripped = if page.to_lowercase().ends_with(".md") {
                    &page[..page.len() - 3]
                } else {
                    page
                };
                let normalized: String = stripped.nfc().collect();

                if normalized.is_empty() || existing_pages.contains(&normalized) {
                    continue;
                }

                // Build context (3 lines before and after)
                let context_before: Vec<String> = (line_idx.saturating_sub(3)..line_idx)
                    .map(|i| lines[i].to_string())
                    .collect();
                let context_after: Vec<String> =
                    ((line_idx + 1)..std::cmp::min(line_idx + 4, lines.len()))
                        .map(|i| lines[i].to_string())
                        .collect();

                unresolved_map
                    .entry(normalized)
                    .or_default()
                    .push(WikilinkReference {
                        file_path: file_path.clone(),
                        line_number: line_idx + 1,
                        byte_offset,
                        line_content: line.to_string(),
                        context_before,
                        context_after,
                    });
            }
        }
    }

    let mut result: Vec<UnresolvedWikilink> = unresolved_map
        .into_iter()
        .map(|(page_name, references)| UnresolvedWikilink {
            page_name,
            references,
        })
        .collect();
    result.sort_by(|a, b| a.page_name.cmp(&b.page_name));

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_search_files_finds_matches() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("test.md"),
            "Hello World\nfoo bar\nhello again",
        )
        .unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].line_number, 1);
        assert_eq!(results[0].match_start, 0);
        assert_eq!(results[0].match_end, 5);
        assert_eq!(results[1].line_number, 3);
    }

    #[test]
    fn test_search_files_case_insensitive() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "Hello HELLO hElLo").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn test_search_files_lowercase_length_change() {
        let dir = tempdir().unwrap();
        // İ (U+0130) lowercases to "i\u{0307}" (2 chars), so offsets must map
        // back to the original string where İ is 1 char / 1 UTF-16 code unit.
        fs::write(dir.path().join("test.md"), "İhello").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line_content, "İhello");
        // İ is 1 UTF-16 code unit, so "hello" starts at 1
        assert_eq!(results[0].match_start, 1);
        assert_eq!(results[0].match_end, 6);
    }

    #[test]
    fn test_search_files_case_sensitive() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "Hello HELLO hello").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "Hello".to_string(),
            Some(true),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].match_start, 0);
        assert_eq!(results[0].match_end, 5);
    }

    #[test]
    fn test_search_files_multibyte_char_offsets() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "あいう hello world").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        // "あいう " is 4 chars, so "hello" starts at char index 4
        assert_eq!(results[0].match_start, 4);
        assert_eq!(results[0].match_end, 9);
    }

    #[test]
    fn test_search_files_surrogate_pair_offsets() {
        let dir = tempdir().unwrap();
        // U+1F600 (😀) is a supplementary plane char: 1 Rust char, 2 UTF-16 code units
        fs::write(dir.path().join("test.md"), "😀hello world").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        // "😀" = 2 UTF-16 code units, so "hello" starts at index 2
        assert_eq!(results[0].match_start, 2);
        assert_eq!(results[0].match_end, 7);
    }

    #[test]
    fn test_search_files_multiple_surrogate_pairs() {
        let dir = tempdir().unwrap();
        // "🎉🎊test" — each emoji is 2 UTF-16 code units
        fs::write(dir.path().join("test.md"), "🎉🎊test").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "test".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].match_start, 4); // 2+2 UTF-16 code units
        assert_eq!(results[0].match_end, 8);
    }

    #[test]
    fn test_search_files_no_match() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "foo bar baz").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "xyz".to_string(),
            None,
        )
        .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_files_empty_query() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "content").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "".to_string(),
            None,
        )
        .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_files_excludes_hidden() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join(".hidden/secret.md"), "hello").unwrap();
        fs::write(dir.path().join("visible.md"), "hello").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].file_path.contains("visible.md"));
    }

    #[test]
    fn test_search_files_only_md() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "hello").unwrap();
        fs::write(dir.path().join("test.txt"), "hello").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].file_path.contains("test.md"));
    }

    #[test]
    fn test_search_files_recursive() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/nested.md"), "hello").unwrap();

        let results = search_files(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].file_path.contains("nested.md"));
    }

    #[test]
    fn test_search_filenames_fuzzy() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hello-world.md"), "").unwrap();
        fs::write(dir.path().join("another.md"), "").unwrap();

        let results =
            search_filenames(dir.path().to_string_lossy().to_string(), "hw".to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("hello-world.md"));
    }

    #[test]
    fn test_search_filenames_empty_query_returns_all() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();

        let results =
            search_filenames(dir.path().to_string_lossy().to_string(), "".to_string()).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_search_filenames_no_match() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hello.md"), "").unwrap();

        let results =
            search_filenames(dir.path().to_string_lossy().to_string(), "xyz".to_string()).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_fuzzy_match_basic() {
        assert!(fuzzy_match("hw", "hello-world.md"));
        assert!(fuzzy_match("", "anything"));
        assert!(!fuzzy_match("xyz", "hello"));
    }

    #[test]
    fn test_fuzzy_match_case_insensitive() {
        assert!(fuzzy_match("HW", "hello-world.md"));
        assert!(fuzzy_match("hw", "Hello-World.md"));
    }

    // ── scan_unresolved_wikilinks tests ──

    #[test]
    fn test_scan_basic_unresolved_link() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.md"), "See [[missing-page]] for details").unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "missing-page");
        assert_eq!(results[0].references.len(), 1);
        assert_eq!(results[0].references[0].line_number, 1);
    }

    #[test]
    fn test_scan_existing_file_filtered() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("existing.md"), "# Existing").unwrap();
        fs::write(
            dir.path().join("note.md"),
            "Link to [[existing]] and [[missing]]",
        )
        .unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "missing");
    }

    #[test]
    fn test_scan_code_block_excluded() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("note.md"),
            "```\n[[in-code]]\n```\n[[outside-code]]",
        )
        .unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "outside-code");
    }

    #[test]
    fn test_scan_pipe_alias_parsed() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("note.md"),
            "See [[target|display text]] here",
        )
        .unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "target");
    }

    #[test]
    fn test_scan_path_traversal_rejected() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("note.md"),
            "[[../secret]] [[./local]] [[path/to/file]] [[normal]]",
        )
        .unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "normal");
    }

    #[test]
    fn test_scan_japanese_filenames() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("メモ.md"), "# メモ").unwrap();
        fs::write(
            dir.path().join("note.md"),
            "[[メモ]] and [[未作成ページ]]",
        )
        .unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "未作成ページ");
    }

    #[test]
    fn test_scan_context_lines() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("note.md"),
            "line1\nline2\nline3\nline4 [[missing]] here\nline5\nline6\nline7",
        )
        .unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        let ref0 = &results[0].references[0];
        assert_eq!(ref0.line_number, 4);
        assert_eq!(ref0.context_before, vec!["line1", "line2", "line3"]);
        assert_eq!(ref0.context_after, vec!["line5", "line6", "line7"]);
    }

    #[test]
    fn test_scan_multiple_references_same_page() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "See [[missing]]").unwrap();
        fs::write(dir.path().join("b.md"), "Also [[missing]]").unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "missing");
        assert_eq!(results[0].references.len(), 2);
    }

    #[test]
    fn test_scan_tilde_code_block_excluded() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("note.md"),
            "~~~\n[[in-code]]\n~~~\n[[outside]]",
        )
        .unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "outside");
    }

    #[test]
    fn test_scan_empty_wikilink_ignored() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.md"), "[[]] and [[valid]]").unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_name, "valid");
    }

    #[test]
    fn test_scan_md_extension_stripped() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("existing.md"), "# Existing").unwrap();
        fs::write(dir.path().join("note.md"), "[[existing.md]]").unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_scan_multiple_wikilinks_on_same_line() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.md"), "[[alpha]] and [[beta]]").unwrap();

        let results = scan_unresolved_wikilinks(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(results.len(), 2);
        // Results are sorted by page name
        assert_eq!(results[0].page_name, "alpha");
        assert_eq!(results[1].page_name, "beta");
    }
}
