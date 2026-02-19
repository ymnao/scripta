use std::fs;
use std::path::{Path, PathBuf};

fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if p.is_absolute() {
        Ok(p.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let resolved = resolve_path(&path)?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&resolved, &content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_write_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.md").to_string_lossy().to_string();

        write_file(path.clone(), "hello".to_string()).unwrap();
        let content = read_file(path).unwrap();
        assert_eq!(content, "hello");
    }

    #[test]
    fn test_read_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("nonexistent.md")
            .to_string_lossy()
            .to_string();

        let result = read_file(path);
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_path_absolute() {
        let result = resolve_path("/tmp/test.md").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/test.md"));
    }

    #[test]
    fn test_resolve_path_relative() {
        let result = resolve_path("test.md").unwrap();
        let expected = std::env::current_dir().unwrap().join("test.md");
        assert_eq!(result, expected);
    }

    #[test]
    fn test_write_file_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("a/b/c/deep.md")
            .to_string_lossy()
            .to_string();

        write_file(path.clone(), "nested".to_string()).unwrap();
        let content = read_file(path).unwrap();
        assert_eq!(content, "nested");
    }

    #[test]
    fn test_resolve_path_with_parent_traversal() {
        let result = resolve_path("../some/dir/../file.txt").unwrap();
        assert_eq!(
            result.file_name().unwrap(),
            std::ffi::OsStr::new("file.txt")
        );
    }
}
