use std::fs;
use std::path::{Path, PathBuf};

pub(super) fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if p.is_absolute() {
        Ok(p.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .map_err(|e| e.to_string())
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn read_file(path: String) -> Result<String, String> {
    let resolved = resolve_path(&path)?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&resolved, &content).map_err(|e| e.to_string())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn create_file(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    if resolved.exists() {
        return Err(format!("Already exists: {}", resolved.display()));
    }
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::File::create(&resolved).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn create_directory(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    if resolved.exists() {
        return Err(format!("Already exists: {}", resolved.display()));
    }
    fs::create_dir_all(&resolved).map_err(|e| e.to_string())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn rename_entry(old_path: String, new_path: String) -> Result<(), String> {
    let old = resolve_path(&old_path)?;
    let new = resolve_path(&new_path)?;
    if !old.exists() {
        return Err(format!("Source not found: {}", old.display()));
    }
    if new.exists() {
        return Err(format!("Target already exists: {}", new.display()));
    }
    fs::rename(&old, &new).map_err(|e| e.to_string())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn delete_entry(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    if !resolved.exists() {
        return Err(format!("Not found: {}", resolved.display()));
    }
    trash::delete(&resolved).map_err(|e| e.to_string())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn show_in_folder(path: String) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    if !resolved.exists() {
        return Err(format!("Not found: {}", resolved.display()));
    }

    let is_dir = resolved.is_dir();

    #[cfg(target_os = "macos")]
    {
        if is_dir {
            std::process::Command::new("open")
                .arg(&resolved)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&resolved)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "windows")]
    {
        if is_dir {
            std::process::Command::new("explorer")
                .arg(&resolved)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", resolved.display()))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let target = if is_dir {
            resolved.as_path()
        } else {
            resolved.parent().unwrap_or(&resolved)
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return Err("Unsupported platform".to_string());

    Ok(())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn path_exists(path: String) -> Result<bool, String> {
    let resolved = resolve_path(&path)?;
    Ok(resolved.exists())
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

    #[test]
    fn test_create_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md").to_string_lossy().to_string();

        create_file(path.clone()).unwrap();
        assert!(Path::new(&path).exists());

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn test_create_file_with_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/new.md").to_string_lossy().to_string();

        create_file(path.clone()).unwrap();
        assert!(Path::new(&path).exists());
    }

    #[test]
    fn test_create_file_already_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exists.md").to_string_lossy().to_string();

        fs::write(&path, "content").unwrap();
        let result = create_file(path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Already exists"));
    }

    #[test]
    fn test_create_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("newdir").to_string_lossy().to_string();

        create_directory(path.clone()).unwrap();
        assert!(Path::new(&path).is_dir());
    }

    #[test]
    fn test_create_directory_already_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existdir").to_string_lossy().to_string();

        fs::create_dir(&path).unwrap();
        let result = create_directory(path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Already exists"));
    }

    #[test]
    fn test_rename_entry() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md").to_string_lossy().to_string();
        let new = dir.path().join("new.md").to_string_lossy().to_string();

        fs::write(&old, "content").unwrap();
        rename_entry(old.clone(), new.clone()).unwrap();

        assert!(!Path::new(&old).exists());
        assert!(Path::new(&new).exists());
        assert_eq!(fs::read_to_string(&new).unwrap(), "content");
    }

    #[test]
    fn test_rename_entry_source_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir
            .path()
            .join("nonexistent.md")
            .to_string_lossy()
            .to_string();
        let new = dir.path().join("new.md").to_string_lossy().to_string();

        let result = rename_entry(old, new);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Source not found"));
    }

    #[test]
    fn test_rename_entry_target_exists() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md").to_string_lossy().to_string();
        let new = dir.path().join("new.md").to_string_lossy().to_string();

        fs::write(&old, "old").unwrap();
        fs::write(&new, "new").unwrap();

        let result = rename_entry(old, new);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Target already exists"));
    }

    #[test]
    fn test_delete_entry_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("nonexistent.md")
            .to_string_lossy()
            .to_string();

        let result = delete_entry(path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not found"));
    }

    #[test]
    fn test_path_exists_true() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exist.md").to_string_lossy().to_string();
        fs::write(&path, "content").unwrap();
        assert!(path_exists(path).unwrap());
    }

    #[test]
    fn test_path_exists_false() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("nonexistent.md")
            .to_string_lossy()
            .to_string();
        assert!(!path_exists(path).unwrap());
    }

    #[test]
    fn test_path_exists_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(path_exists(path).unwrap());
    }

    #[test]
    fn test_show_in_folder_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("nonexistent.md")
            .to_string_lossy()
            .to_string();

        let result = show_in_folder(path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not found"));
    }

}
