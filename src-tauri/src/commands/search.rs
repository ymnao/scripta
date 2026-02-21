use super::file::resolve_path;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub file_path: String,
    pub line_number: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
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
pub fn search_files(workspace_path: String, query: String) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let resolved = resolve_path(&workspace_path)?;
    let mut md_files = Vec::new();
    collect_md_files(&resolved, &mut md_files)?;
    md_files.sort();

    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for file_path in &md_files {
        let content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (line_idx, line) in content.lines().enumerate() {
            let line_lower = line.to_lowercase();
            let mut search_start = 0;
            while let Some(pos) = line_lower[search_start..].find(&query_lower) {
                let match_start = search_start + pos;
                let match_end = match_start + query.len();
                results.push(SearchResult {
                    file_path: file_path.clone(),
                    line_number: line_idx + 1,
                    line_content: line.to_string(),
                    match_start,
                    match_end,
                });
                search_start = match_end;
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
        .filter(|path| fuzzy_match(&query, path))
        .collect();

    Ok(matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_search_files_finds_matches() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "Hello World\nfoo bar\nhello again").unwrap();

        let results =
            search_files(dir.path().to_string_lossy().to_string(), "hello".to_string()).unwrap();
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

        let results =
            search_files(dir.path().to_string_lossy().to_string(), "hello".to_string()).unwrap();
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn test_search_files_no_match() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "foo bar baz").unwrap();

        let results =
            search_files(dir.path().to_string_lossy().to_string(), "xyz".to_string()).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_files_empty_query() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "content").unwrap();

        let results =
            search_files(dir.path().to_string_lossy().to_string(), "".to_string()).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_files_excludes_hidden() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join(".hidden/secret.md"), "hello").unwrap();
        fs::write(dir.path().join("visible.md"), "hello").unwrap();

        let results =
            search_files(dir.path().to_string_lossy().to_string(), "hello".to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].file_path.contains("visible.md"));
    }

    #[test]
    fn test_search_files_only_md() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "hello").unwrap();
        fs::write(dir.path().join("test.txt"), "hello").unwrap();

        let results =
            search_files(dir.path().to_string_lossy().to_string(), "hello".to_string()).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].file_path.contains("test.md"));
    }

    #[test]
    fn test_search_files_recursive() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/nested.md"), "hello").unwrap();

        let results =
            search_files(dir.path().to_string_lossy().to_string(), "hello".to_string()).unwrap();
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
}
