use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::file::resolve_path;

#[cfg(feature = "tauri-app")]
use tauri::async_runtime::spawn_blocking;
#[cfg(not(feature = "tauri-app"))]
use tokio::task::spawn_blocking;

/// Maximum size (in bytes) for conflict content returned to the frontend.
/// Prevents OOM when a large binary file is in conflict.
const MAX_CONFLICT_CONTENT_SIZE: usize = 10 * 1024 * 1024; // 10 MB

fn is_stage_not_found(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("does not exist")
        || lower.contains("not at stage")
        || lower.contains("invalid object name")
        || lower.contains("not a valid object name")
}

fn validate_relative_path(file_path: &str) -> Result<(), String> {
    if file_path.is_empty() {
        return Err("file_path must not be empty".to_string());
    }
    // Reject control characters (NUL, newlines, etc.) that could confuse git or filesystem
    if file_path.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err("file_path must not contain control characters".to_string());
    }
    let p = Path::new(file_path);
    if p.is_absolute() {
        return Err("file_path must be relative".to_string());
    }
    if p.file_name().is_none() {
        return Err("file_path must point to a file, not a directory".to_string());
    }
    for component in p.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("file_path must not contain '..'".to_string());
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("file_path must be relative".to_string());
            }
            std::path::Component::CurDir => {
                return Err("file_path must not contain '.'".to_string());
            }
            std::path::Component::Normal(_) => {}
        }
    }
    Ok(())
}

/// Validates that a git ref name (branch/remote) contains only safe characters.
/// Rejects control characters, spaces, and special git metacharacters.
fn validate_ref_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("ref name must not be empty".to_string());
    }
    if name.contains("..") || name.contains("~") || name.contains("^") || name.contains(":") {
        return Err(format!("ref name contains invalid characters: {name}"));
    }
    if name.bytes().any(|b| b < 0x20 || b == 0x7f || b == b' ' || b == b'\\') {
        return Err(format!("ref name contains control characters or spaces: {name}"));
    }
    if name.starts_with('-') || name.starts_with('.') || name.ends_with('.') || name.ends_with(".lock") {
        return Err(format!("ref name has invalid prefix/suffix: {name}"));
    }
    Ok(())
}

/// Resolves the `.git` directory for a repository, handling both standard
/// repos and worktrees.
fn resolve_git_dir(path: &str) -> Result<PathBuf, String> {
    let git_dir = run_git(path, &["rev-parse", "--git-dir"])?;
    let resolved = resolve_path(path)?;
    Ok(if Path::new(&git_dir).is_relative() {
        resolved.join(&git_dir)
    } else {
        PathBuf::from(&git_dir)
    })
}

/// Returns `true` when the repository is in the middle of a rebase operation.
fn is_rebasing(git_path: &Path) -> bool {
    git_path.join("rebase-merge").exists() || git_path.join("rebase-apply").exists()
}

/// Returns `true` when the repository is in the middle of a merge or rebase.
fn is_merging_or_rebasing(git_path: &Path) -> bool {
    git_path.join("MERGE_HEAD").exists() || is_rebasing(git_path)
}

/// Verifies that `target` is not a symlink and that it resides within `root`.
/// This prevents TOCTOU attacks where a symlink could be swapped in between
/// path validation and file write.
fn safe_write_in_repo(target: &Path, root: &Path, content: &str) -> Result<(), String> {
    // Re-check that target is within root immediately before write
    // (defends against race where a symlink replaces the path after canonicalize)
    if target.is_symlink() {
        return Err("file_path is a symlink; refusing to write".to_string());
    }
    // Verify the parent also isn't a symlink that appeared after canonicalization
    if let Some(parent) = target.parent() {
        if parent != root && parent.is_symlink() {
            return Err("parent directory is a symlink; refusing to write".to_string());
        }
    }
    if !target.starts_with(root) {
        return Err("file_path escapes repository directory".to_string());
    }
    std::fs::write(target, content).map_err(|e| e.to_string())
}

fn git_command(path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let resolved = resolve_path(path)?;
    // Use a platform-appropriate non-existent path to disable git hooks.
    // /dev/null (Unix) and NUL (Windows) are not directories, so git finds no hooks there.
    let null_hooks_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    Command::new("git")
        .current_dir(&resolved)
        // Force English output so error-message parsing is locale-independent
        .env("LC_ALL", "C")
        // Prevent interactive prompts (auth, passphrase) from hanging the process
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        // Treat all pathspec arguments as literal strings, preventing pathspec
        // magic (e.g. ":(glob)", ":(exclude)") from matching unintended files.
        .env("GIT_LITERAL_PATHSPECS", "1")
        // Disable git hooks to prevent arbitrary code execution from auto-sync
        .arg("-c")
        .arg(format!("core.hooksPath={null_hooks_path}"))
        // Prevent quoting of non-ASCII filenames (e.g. Japanese characters)
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))
}

fn format_git_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git command failed with status: {}", output.status)
    }
}

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command(path, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format_git_error(&output))
    }
}

/// Like `run_git` but does not trim stdout, preserving original content.
/// Use for commands where the output content matters (e.g. `git show`).
fn run_git_raw(path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command(path, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format_git_error(&output))
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
    spawn_blocking(|| match Command::new("git").arg("--version").output() {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_check_repo(path: String) -> Result<bool, String> {
    spawn_blocking(move || {
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
    spawn_blocking(move || {
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
    spawn_blocking(move || {
        run_git(&path, &["add", "-A"])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    spawn_blocking(move || run_git(&path, &["commit", "-m", &message]))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_pull(path: String, sync_method: String) -> Result<String, String> {
    spawn_blocking(move || {
        let args = match sync_method.as_str() {
            "rebase" => vec!["pull", "--rebase"],
            "merge" => vec!["pull"],
            _ => return Err(format!("Invalid sync_method: {sync_method}. Expected \"merge\" or \"rebase\".")),
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
    spawn_blocking(move || {
        match run_git(&path, &["push"]) {
            Ok(output) => Ok(output),
            Err(e) if e.contains("no upstream branch") || e.contains("has no upstream") => {
                let branch =
                    run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
                if branch.is_empty() {
                    return Err(e);
                }
                validate_ref_name(&branch)?;
                // Use the first configured remote (usually "origin")
                let remote = run_git(&path, &["remote"])
                    .ok()
                    .and_then(|r| r.lines().next().map(|l| l.to_string()))
                    .unwrap_or_else(|| "origin".to_string());
                validate_ref_name(&remote)?;
                run_git(&path, &["push", "-u", &remote, &branch])
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}


#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_get_conflicted_files(path: String) -> Result<Vec<String>, String> {
    spawn_blocking(move || {
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
    spawn_blocking(move || {
        validate_relative_path(&file_path)?;
        let ours_ref = format!(":2:{file_path}");
        let theirs_ref = format!(":3:{file_path}");
        // For modify/delete conflicts (DU/UD), one side may not exist in the index.
        // Stage references (:2:, :3:) are rev-specs, not paths — do not use "--" here
        // as it would cause git to interpret the ref as a pathspec.
        // Only stage-not-found errors are tolerated; other failures propagate.
        let ours = match run_git_raw(&path, &["show", &ours_ref]) {
            Ok(content) => {
                if content.len() > MAX_CONFLICT_CONTENT_SIZE {
                    return Err(format!(
                        "Conflict content for ours ({} bytes) exceeds {} byte limit",
                        content.len(),
                        MAX_CONFLICT_CONTENT_SIZE
                    ));
                }
                content
            }
            Err(e) if is_stage_not_found(&e) => String::new(),
            Err(e) => return Err(e),
        };
        let theirs = match run_git_raw(&path, &["show", &theirs_ref]) {
            Ok(content) => {
                if content.len() > MAX_CONFLICT_CONTENT_SIZE {
                    return Err(format!(
                        "Conflict content for theirs ({} bytes) exceeds {} byte limit",
                        content.len(),
                        MAX_CONFLICT_CONTENT_SIZE
                    ));
                }
                content
            }
            Err(e) if is_stage_not_found(&e) => String::new(),
            Err(e) => return Err(e),
        };
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
    spawn_blocking(move || {
        validate_relative_path(&file_path)?;

        if resolution != "modify" && resolution != "delete" {
            return Err(format!("Invalid resolution: {resolution}. Expected \"modify\" or \"delete\"."));
        }

        if resolution == "delete" {
            // Delete resolution only removes from the index; no need to canonicalize
            // the file path (the file may not exist on disk).
            run_git(&path, &["rm", "-f", "--", &file_path])?;
        } else {
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
                        parent
                            .canonicalize()
                            .map(|p| p.join(full_path.file_name().unwrap_or_default()))
                    } else {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            "no parent",
                        ))
                    }
                })
                .map_err(|e| e.to_string())?;
            if !canonical.starts_with(&canonical_root) {
                return Err("file_path escapes repository directory".to_string());
            }
            // Ensure parent directories exist (e.g. "newdir/file.md" during conflict resolution)
            if let Some(parent) = canonical.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            safe_write_in_repo(&canonical, &canonical_root, &content)?;
            run_git(&path, &["add", "--", &file_path])?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Finishes conflict resolution by detecting whether we are in a rebase or merge
/// and running the appropriate command (`git rebase --continue` or `git commit --no-edit`).
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_finish_conflict_resolution(path: String) -> Result<String, String> {
    spawn_blocking(move || {
        let git_path = resolve_git_dir(&path)?;

        if !is_merging_or_rebasing(&git_path) {
            return Err("Not in a merge or rebase state".to_string());
        }

        if is_rebasing(&git_path) {
            run_git(&path, &["rebase", "--continue"])
        } else {
            // For merge conflicts, use --no-edit to keep the auto-generated merge message
            run_git(&path, &["commit", "--no-edit"])
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn git_get_last_commit_time(path: String) -> Result<Option<String>, String> {
    spawn_blocking(move || {
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

    #[test]
    fn test_validate_relative_path_rejects_absolute() {
        assert!(validate_relative_path("/etc/passwd").is_err());
    }

    #[test]
    fn test_validate_relative_path_rejects_parent_traversal() {
        assert!(validate_relative_path("../secret.md").is_err());
        assert!(validate_relative_path("subdir/../../etc/passwd").is_err());
    }

    #[test]
    fn test_validate_relative_path_rejects_control_chars() {
        assert!(validate_relative_path("file\x00.md").is_err());
        assert!(validate_relative_path("file\n.md").is_err());
        assert!(validate_relative_path("file\x7f.md").is_err());
    }

    #[test]
    fn test_validate_relative_path_accepts_valid() {
        assert!(validate_relative_path("notes/hello.md").is_ok());
        assert!(validate_relative_path("日本語ファイル.md").is_ok());
    }

    #[test]
    fn test_validate_ref_name_rejects_invalid() {
        assert!(validate_ref_name("").is_err());
        assert!(validate_ref_name("main..dev").is_err());
        assert!(validate_ref_name("refs~1").is_err());
        assert!(validate_ref_name("refs^1").is_err());
        assert!(validate_ref_name("refs:heads").is_err());
        assert!(validate_ref_name("-start").is_err());
        assert!(validate_ref_name(".hidden").is_err());
        assert!(validate_ref_name("branch.lock").is_err());
        assert!(validate_ref_name("branch name").is_err());
        assert!(validate_ref_name("branch\t").is_err());
    }

    #[test]
    fn test_validate_ref_name_accepts_valid() {
        assert!(validate_ref_name("main").is_ok());
        assert!(validate_ref_name("feature/my-branch").is_ok());
        assert!(validate_ref_name("origin").is_ok());
        assert!(validate_ref_name("v1.0.0").is_ok());
    }

    #[test]
    fn test_safe_write_in_repo_rejects_outside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let outside = std::env::temp_dir().join("outside.txt");
        let result = safe_write_in_repo(&outside, root, "data");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("escapes repository"));
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
