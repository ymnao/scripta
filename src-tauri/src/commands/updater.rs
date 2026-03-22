use serde::{Deserialize, Serialize};
use std::io::Read;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub has_update: bool,
    pub latest_version: String,
    pub current_version: String,
    pub release_url: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
}

const GITHUB_API_URL: &str = "https://api.github.com/repos/ymnao/scripta/releases/latest";
const MAX_RESPONSE_BYTES: u64 = 100 * 1024; // 100KB

fn strip_v_prefix(version: &str) -> &str {
    version.strip_prefix('v').unwrap_or(version)
}

fn compare_versions(
    current_version: &str,
    release: &GitHubRelease,
) -> Result<UpdateInfo, String> {
    let current = semver::Version::parse(current_version)
        .map_err(|e| format!("Invalid current version '{}': {}", current_version, e))?;

    let latest_str = strip_v_prefix(&release.tag_name);
    let latest = semver::Version::parse(latest_str)
        .map_err(|e| format!("Invalid latest version '{}': {}", latest_str, e))?;

    Ok(UpdateInfo {
        has_update: latest > current,
        latest_version: latest_str.to_string(),
        current_version: current_version.to_string(),
        release_url: release.html_url.clone(),
    })
}

fn fetch_latest_release() -> Result<GitHubRelease, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();

    let response = agent
        .get(GITHUB_API_URL)
        .set("User-Agent", "scripta")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Failed to fetch releases: {}", e))?;

    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES)
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read response: {}", e))?;

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))
}

pub fn check_for_update_inner(current_version: &str) -> Result<UpdateInfo, String> {
    // Validate current version before making network request
    semver::Version::parse(current_version)
        .map_err(|e| format!("Invalid current version '{}': {}", current_version, e))?;

    let release = fetch_latest_release()?;
    compare_versions(current_version, &release)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn check_for_update(current_version: String) -> Result<UpdateInfo, String> {
    check_for_update_inner(&current_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_v_prefix() {
        assert_eq!(strip_v_prefix("v1.2.3"), "1.2.3");
        assert_eq!(strip_v_prefix("1.2.3"), "1.2.3");
        assert_eq!(strip_v_prefix("v0.1.0"), "0.1.0");
    }

    #[test]
    fn test_compare_versions_has_update() {
        let release = GitHubRelease {
            tag_name: "v1.0.0".to_string(),
            html_url: "https://github.com/ymnao/scripta/releases/tag/v1.0.0".to_string(),
        };
        let info = compare_versions("0.1.0", &release).unwrap();
        assert!(info.has_update);
        assert_eq!(info.latest_version, "1.0.0");
        assert_eq!(info.current_version, "0.1.0");
        assert_eq!(info.release_url, release.html_url);
    }

    #[test]
    fn test_compare_versions_no_update() {
        let release = GitHubRelease {
            tag_name: "v0.1.0".to_string(),
            html_url: "https://github.com/ymnao/scripta/releases/tag/v0.1.0".to_string(),
        };
        let info = compare_versions("0.1.0", &release).unwrap();
        assert!(!info.has_update);
    }

    #[test]
    fn test_compare_versions_older_release() {
        let release = GitHubRelease {
            tag_name: "v0.0.9".to_string(),
            html_url: "https://github.com/ymnao/scripta/releases/tag/v0.0.9".to_string(),
        };
        let info = compare_versions("0.1.0", &release).unwrap();
        assert!(!info.has_update);
    }

    #[test]
    fn test_compare_versions_prerelease() {
        let release = GitHubRelease {
            tag_name: "v1.0.0-beta.1".to_string(),
            html_url: "https://github.com/ymnao/scripta/releases/tag/v1.0.0-beta.1".to_string(),
        };
        let info = compare_versions("1.0.0", &release).unwrap();
        assert!(!info.has_update);
    }

    #[test]
    fn test_compare_versions_invalid_current() {
        let release = GitHubRelease {
            tag_name: "v1.0.0".to_string(),
            html_url: "https://github.com/ymnao/scripta/releases/tag/v1.0.0".to_string(),
        };
        let err = compare_versions("not-a-version", &release).unwrap_err();
        assert!(err.contains("Invalid current version"));
    }

    #[test]
    fn test_compare_versions_invalid_release_tag() {
        let release = GitHubRelease {
            tag_name: "invalid-tag".to_string(),
            html_url: "https://github.com/ymnao/scripta/releases/tag/invalid-tag".to_string(),
        };
        let err = compare_versions("0.1.0", &release).unwrap_err();
        assert!(err.contains("Invalid latest version"));
    }

    #[test]
    fn test_compare_versions_tag_without_v_prefix() {
        let release = GitHubRelease {
            tag_name: "1.0.0".to_string(),
            html_url: "https://github.com/ymnao/scripta/releases/tag/1.0.0".to_string(),
        };
        let info = compare_versions("0.1.0", &release).unwrap();
        assert!(info.has_update);
    }

    #[test]
    fn test_invalid_version_fails_before_network() {
        let err = check_for_update_inner("not-a-version").unwrap_err();
        assert!(
            err.contains("Invalid current version"),
            "Expected version parse error, got: {}",
            err
        );
    }
}
