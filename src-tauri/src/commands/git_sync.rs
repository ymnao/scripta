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
pub async fn git_check_available() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| match Command::new("git").arg("--version").output() {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_check_repo(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        match run_git(&path, &["rev-parse", "--is-inside-work-tree"]) {
            Ok(output) => Ok(output == "true"),
            Err(_) => Ok(false),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_status(path: String) -> Result<GitStatusResult, String> {
    tokio::task::spawn_blocking(move || {
        let branch =
            run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();

        let porcelain = run_git(&path, &["status", "--porcelain"])?;
        let changed_files_count = porcelain.lines().filter(|l| !l.is_empty()).count() as u32;

        let conflict_files: Vec<String> = porcelain
            .lines()
            .filter(|l| {
                matches!(
                    l.get(..3),
                    Some("UU " | "AA " | "DD " | "AU " | "UA " | "DU " | "UD ")
                )
            })
            .map(|l| l[3..].to_string())
            .collect();

        let has_remote = run_git(&path, &["remote"]).map_or(false, |r| !r.is_empty());

        Ok(GitStatusResult {
            branch,
            changed_files_count,
            conflict_files,
            has_remote,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_add_all(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&path, &["add", "-A"])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git(&path, &["commit", "-m", &message]))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_pull(path: String, sync_method: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let args = if sync_method == "rebase" {
            vec!["pull", "--rebase"]
        } else {
            vec!["pull"]
        };
        match run_git(&path, &args) {
            Ok(output) => Ok(output),
            Err(e) if e.contains("no tracking information") => Ok(String::new()),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_push(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        match run_git(&path, &["push"]) {
            Ok(output) => Ok(output),
            Err(e) if e.contains("no upstream branch") || e.contains("has no upstream") => {
                let branch =
                    run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
                if branch.is_empty() {
                    return Err(e);
                }
                // Use the first configured remote (usually "origin")
                let remote = run_git(&path, &["remote"])
                    .ok()
                    .and_then(|r| r.lines().next().map(|l| l.to_string()))
                    .unwrap_or_else(|| "origin".to_string());
                run_git(&path, &["push", "-u", &remote, &branch])
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_unpushed_count(path: String) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        match run_git(&path, &["rev-list", "@{u}..HEAD", "--count"]) {
            Ok(output) => output.parse::<u32>().map_err(|e| e.to_string()),
            Err(_) => Ok(0),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_get_conflicted_files(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&path, &["diff", "--name-only", "--diff-filter=U"])?;
        Ok(output
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_get_conflict_content(
    path: String,
    file_path: String,
) -> Result<ConflictContentResult, String> {
    tokio::task::spawn_blocking(move || {
        let ours_ref = format!(":2:{file_path}");
        let theirs_ref = format!(":3:{file_path}");
        let ours = run_git(&path, &["show", &ours_ref])?;
        let theirs = run_git(&path, &["show", &theirs_ref])?;
        Ok(ConflictContentResult { ours, theirs })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_resolve_conflict(
    path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let resolved = resolve_path(&path)?;
        let full_path = resolved.join(&file_path);
        std::fs::write(&full_path, &content).map_err(|e| e.to_string())?;
        run_git(&path, &["add", &file_path])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_get_last_commit_time(path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        match run_git(&path, &["log", "-1", "--format=%ci"]) {
            Ok(output) if !output.is_empty() => Ok(Some(output)),
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
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

    #[tokio::test]
    async fn test_git_check_repo() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        assert!(git_check_repo(path).await.unwrap());
    }

    #[tokio::test]
    async fn test_git_check_repo_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(!git_check_repo(path).await.unwrap());
    }

    #[tokio::test]
    async fn test_git_status_empty_repo() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let status = git_status(path).await.unwrap();
        assert_eq!(status.changed_files_count, 0);
        assert!(status.conflict_files.is_empty());
        assert!(!status.has_remote);
    }

    #[tokio::test]
    async fn test_git_status_with_changes() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("test.md"), "hello").unwrap();
        let status = git_status(path).await.unwrap();
        assert_eq!(status.changed_files_count, 1);
    }

    #[tokio::test]
    async fn test_git_add_all_and_commit() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("test.md"), "hello").unwrap();

        git_add_all(path.clone()).await.unwrap();
        let result = git_commit(path, "test commit".to_string()).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_git_get_last_commit_time() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();

        // No commits yet
        let time = git_get_last_commit_time(path.clone()).await.unwrap();
        assert!(time.is_none());

        // Make a commit
        fs::write(dir.path().join("test.md"), "hello").unwrap();
        git_add_all(path.clone()).await.unwrap();
        git_commit(path.clone(), "initial".to_string()).await.unwrap();

        let time = git_get_last_commit_time(path).await.unwrap();
        assert!(time.is_some());
    }

    #[tokio::test]
    async fn test_git_check_available() {
        let result = git_check_available().await.unwrap();
        assert!(result);
    }
}
