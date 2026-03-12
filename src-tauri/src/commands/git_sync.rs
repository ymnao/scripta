use serde::Serialize;
use std::path::Path;
use std::process::Command;

use super::file::resolve_path;

fn validate_relative_path(file_path: &str) -> Result<(), String> {
    let p = Path::new(file_path);
    if p.is_absolute() {
        return Err("file_path must be relative".to_string());
    }
    for component in p.components() {
        if let std::path::Component::ParentDir = component {
            return Err("file_path must not contain '..'".to_string());
        }
    }
    Ok(())
}

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
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git command failed with status: {}", output.status)
        };
        Err(message)
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
        validate_relative_path(&file_path)?;
        let ours_ref = format!(":2:{file_path}");
        let theirs_ref = format!(":3:{file_path}");
        // For modify/delete conflicts (DU/UD), one side may not exist in the index.
        // Use "--" to prevent file_path starting with "-" from being interpreted as an option.
        let ours = run_git(&path, &["show", "--", &ours_ref]).unwrap_or_default();
        let theirs = run_git(&path, &["show", "--", &theirs_ref]).unwrap_or_default();
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
    resolution: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_relative_path(&file_path)?;
        let resolved = resolve_path(&path)?;
        // Canonicalize the repo root for consistent comparison (handles symlinks like /var → /private/var)
        let canonical_root = resolved.canonicalize().map_err(|e| e.to_string())?;
        // Verify the target path is within the repository
        let full_path = canonical_root.join(&file_path);
        let canonical = full_path
            .canonicalize()
            .or_else(|_| {
                // File may not exist yet (e.g. for modify resolution); check parent
                if let Some(parent) = full_path.parent() {
                    parent.canonicalize().map(|p| p.join(full_path.file_name().unwrap_or_default()))
                } else {
                    Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no parent"))
                }
            })
            .map_err(|e| e.to_string())?;
        if !canonical.starts_with(&canonical_root) {
            return Err("file_path escapes repository directory".to_string());
        }

        if resolution == "delete" {
            run_git(&path, &["rm", "-f", "--", &file_path])?;
        } else {
            std::fs::write(&canonical, &content).map_err(|e| e.to_string())?;
            run_git(&path, &["add", "--", &file_path])?;
        }
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

    #[tokio::test]
    async fn test_git_get_conflict_content_missing_stage() {
        // Simulate calling git_get_conflict_content for a file that has no
        // stage 2/3 entries (e.g. modify/delete conflict). The function should
        // return empty strings instead of failing.
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();

        // Create an initial commit so we have a valid repo
        fs::write(dir.path().join("test.md"), "hello").unwrap();
        git_add_all(path.clone()).await.unwrap();
        git_commit(path.clone(), "initial".to_string()).await.unwrap();

        // Ask for conflict content of a file with no conflict stages.
        // This must not fail — it should return empty strings.
        let result = git_get_conflict_content(path, "test.md".to_string()).await.unwrap();
        assert!(result.ours.is_empty());
        assert!(result.theirs.is_empty());
    }

    #[tokio::test]
    async fn test_git_resolve_conflict_delete() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();

        fs::write(dir.path().join("delete-me.md"), "content").unwrap();
        git_add_all(path.clone()).await.unwrap();
        git_commit(path.clone(), "add file".to_string()).await.unwrap();

        // "delete" resolution should remove the file via git rm
        let result = git_resolve_conflict(
            path.clone(),
            "delete-me.md".to_string(),
            String::new(),
            "delete".to_string(),
        )
        .await;
        assert!(result.is_ok());
        assert!(!dir.path().join("delete-me.md").exists());
    }

    #[tokio::test]
    async fn test_git_resolve_conflict_modify() {
        let dir = init_test_repo();
        let path = dir.path().to_string_lossy().to_string();

        fs::write(dir.path().join("keep.md"), "original").unwrap();
        git_add_all(path.clone()).await.unwrap();
        git_commit(path.clone(), "add file".to_string()).await.unwrap();

        // "modify" resolution should write the content and git add
        let result = git_resolve_conflict(
            path.clone(),
            "keep.md".to_string(),
            "resolved content".to_string(),
            "modify".to_string(),
        )
        .await;
        assert!(result.is_ok());
        let content = fs::read_to_string(dir.path().join("keep.md")).unwrap();
        assert_eq!(content, "resolved content");
    }
}
