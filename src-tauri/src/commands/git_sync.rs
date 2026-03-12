use serde::Serialize;
use std::process::Command;

use super::file::resolve_path;

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let resolved = resolve_path(path)?;
    let output = Command::new("git")
        .current_dir(&resolved)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: String,
    pub changed_files_count: u32,
    pub conflict_files: Vec<String>,
    pub has_remote: bool,
}

#[derive(Debug, Serialize)]
pub struct ConflictContentResult {
    pub ours: String,
    pub theirs: String,
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_check_available() -> Result<bool, String> {
    match Command::new("git").arg("--version").output() {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_check_repo(path: String) -> Result<bool, String> {
    match run_git(&path, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(output) => Ok(output == "true"),
        Err(_) => Ok(false),
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_status(path: String) -> Result<GitStatusResult, String> {
    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();

    let porcelain = run_git(&path, &["status", "--porcelain"])?;
    let changed_files_count = porcelain.lines().filter(|l| !l.is_empty()).count() as u32;

    let conflict_files: Vec<String> = porcelain
        .lines()
        .filter(|l| l.starts_with("UU ") || l.starts_with("AA ") || l.starts_with("DD "))
        .map(|l| l[3..].to_string())
        .collect();

    let has_remote = run_git(&path, &["remote"]).map_or(false, |r| !r.is_empty());

    Ok(GitStatusResult {
        branch,
        changed_files_count,
        conflict_files,
        has_remote,
    })
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_add_all(path: String) -> Result<(), String> {
    run_git(&path, &["add", "-A"])?;
    Ok(())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git(&path, &["commit", "-m", &message])
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_pull(path: String, sync_method: String) -> Result<String, String> {
    let args = if sync_method == "rebase" {
        vec!["pull", "--rebase"]
    } else {
        vec!["pull"]
    };
    run_git(&path, &args)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_push(path: String) -> Result<String, String> {
    run_git(&path, &["push"])
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_unpushed_count(path: String) -> Result<u32, String> {
    match run_git(&path, &["rev-list", "@{u}..HEAD", "--count"]) {
        Ok(output) => output.parse::<u32>().map_err(|e| e.to_string()),
        Err(_) => Ok(0),
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_get_conflicted_files(path: String) -> Result<Vec<String>, String> {
    let output = run_git(&path, &["diff", "--name-only", "--diff-filter=U"])?;
    Ok(output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_get_conflict_content(
    path: String,
    file_path: String,
) -> Result<ConflictContentResult, String> {
    let ours_ref = format!(":2:{file_path}");
    let theirs_ref = format!(":3:{file_path}");
    let ours = run_git(&path, &["show", &ours_ref])?;
    let theirs = run_git(&path, &["show", &theirs_ref])?;
    Ok(ConflictContentResult { ours, theirs })
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_resolve_conflict(
    path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let resolved = resolve_path(&path)?;
    let full_path = resolved.join(&file_path);
    std::fs::write(&full_path, &content).map_err(|e| e.to_string())?;
    run_git(&path, &["add", &file_path])?;
    Ok(())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn git_get_last_commit_time(path: String) -> Result<Option<String>, String> {
    match run_git(&path, &["log", "-1", "--format=%ci"]) {
        Ok(output) if !output.is_empty() => Ok(Some(output)),
        Ok(_) => Ok(None),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        run_git(&path, &["init"]).unwrap();
        run_git(&path, &["config", "user.email", "test@test.com"]).unwrap();
        run_git(&path, &["config", "user.name", "Test"]).unwrap();
        dir
    }

    #[test]
    fn test_git_check_repo() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        assert!(git_check_repo(path).unwrap());
    }

    #[test]
    fn test_git_check_repo_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(!git_check_repo(path).unwrap());
    }

    #[test]
    fn test_git_status_empty_repo() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let status = git_status(path).unwrap();
        assert_eq!(status.changed_files_count, 0);
        assert!(status.conflict_files.is_empty());
        assert!(!status.has_remote);
    }

    #[test]
    fn test_git_status_with_changes() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("test.md"), "hello").unwrap();
        let status = git_status(path).unwrap();
        assert_eq!(status.changed_files_count, 1);
    }

    #[test]
    fn test_git_add_all_and_commit() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("test.md"), "hello").unwrap();

        git_add_all(path.clone()).unwrap();
        let result = git_commit(path, "test commit".to_string());
        assert!(result.is_ok());
    }

    #[test]
    fn test_git_get_last_commit_time() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();

        // No commits yet
        let time = git_get_last_commit_time(path.clone()).unwrap();
        assert!(time.is_none());

        // Make a commit
        fs::write(dir.path().join("test.md"), "hello").unwrap();
        git_add_all(path.clone()).unwrap();
        git_commit(path.clone(), "initial".to_string()).unwrap();

        let time = git_get_last_commit_time(path).unwrap();
        assert!(time.is_some());
    }

    #[test]
    fn test_git_check_available() {
        let result = git_check_available().unwrap();
        assert!(result);
    }
}
