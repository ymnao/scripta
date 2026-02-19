use serde::Serialize;
use std::fs;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = fs::read_dir(&path).map_err(|e| e.to_string())?;

    let mut entries: Vec<FileEntry> = dir
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let file_type = entry.file_type().ok()?;
            Some(FileEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_directory: file_type.is_dir(),
            })
        })
        .collect();

    entries.sort_by_key(|entry| (!entry.is_directory, entry.name.to_lowercase()));

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_list_directory_entries() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::write(dir.path().join("b.txt"), "").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = list_directory(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "subdir");
        assert!(entries[0].is_directory);
        assert_eq!(entries[1].name, "a.md");
        assert_eq!(entries[2].name, "b.txt");
    }

    #[test]
    fn test_list_directory_sort_order() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("z.md"), "").unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::create_dir(dir.path().join("beta")).unwrap();
        fs::create_dir(dir.path().join("alpha")).unwrap();

        let entries = list_directory(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(entries[0].name, "alpha");
        assert_eq!(entries[1].name, "beta");
        assert_eq!(entries[2].name, "a.md");
        assert_eq!(entries[3].name, "z.md");
    }

    #[test]
    fn test_list_directory_excludes_hidden() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".hidden"), "").unwrap();
        fs::write(dir.path().join("visible.md"), "").unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();

        let entries = list_directory(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "visible.md");
    }

    #[test]
    fn test_list_directory_empty() {
        let dir = tempdir().unwrap();
        let entries = list_directory(dir.path().to_string_lossy().to_string()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_list_directory_invalid_path() {
        let result = list_directory("/nonexistent/path/that/does/not/exist".to_string());
        assert!(result.is_err());
    }
}
