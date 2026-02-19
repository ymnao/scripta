use super::file::resolve_path;
use serde::Serialize;
use std::fs;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let resolved = resolve_path(&path)?;
    let dir = fs::read_dir(&resolved).map_err(|e| e.to_string())?;

    let mut entries: Vec<FileEntry> = Vec::new();
    for entry_result in dir {
        let entry = entry_result.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_directory: file_type.is_dir(),
        });
    }

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
        let dir = tempdir().unwrap();
        let nonexistent = dir.path().join("nonexistent_subdir");
        let result = list_directory(nonexistent.to_string_lossy().to_string());
        assert!(result.is_err());
    }
}
