use std::fs;

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| e.to_string())
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
        let result = read_file("/nonexistent/path.md".to_string());
        assert!(result.is_err());
    }
}
