use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::time::Instant;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OgpData {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
    pub url: String,
}

struct CacheEntry {
    data: OgpData,
    fetched_at: Instant,
}

pub struct OgpCache {
    entries: HashMap<String, CacheEntry>,
}

const CACHE_TTL_SECS: u64 = 24 * 60 * 60; // 24 hours
const MAX_CACHE_ENTRIES: usize = 500;
const MAX_BODY_BYTES: usize = 100 * 1024; // 100KB

impl OgpCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn get(&self, url: &str) -> Option<&OgpData> {
        self.entries.get(url).and_then(|entry| {
            if entry.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS {
                Some(&entry.data)
            } else {
                None
            }
        })
    }

    fn insert(&mut self, url: String, data: OgpData) {
        if self.entries.len() >= MAX_CACHE_ENTRIES && !self.entries.contains_key(&url) {
            // Remove the oldest entry
            if let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, v)| v.fetched_at)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest_key);
            }
        }
        self.entries.insert(
            url,
            CacheEntry {
                data,
                fetched_at: Instant::now(),
            },
        );
    }
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
}

fn extract_og_meta(html: &str, property: &str) -> Option<String> {
    // Match <meta property="og:..." content="..."> or <meta content="..." property="og:...">
    let property_pattern = format!("property=\"og:{}\"", property);
    let property_pattern_single = format!("property='og:{}'", property);

    for line in html.split('<') {
        let lower = line.to_lowercase();
        if !lower.starts_with("meta") {
            continue;
        }

        let has_property =
            lower.contains(&property_pattern) || lower.contains(&property_pattern_single);
        if !has_property {
            continue;
        }

        // Extract content attribute value
        if let Some(content) = extract_attribute(line, "content") {
            let decoded = decode_html_entities(&content);
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

fn extract_title_tag(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?.checked_add(6)?;
    let rest = &lower[start..];
    // Skip past the closing '>' of the opening tag
    let content_start = rest.find('>')? + 1;
    let content_rest = &html[start + content_start..];
    let end = content_rest.to_lowercase().find("</title>")?;
    let title = content_rest[..end].trim().to_string();
    let decoded = decode_html_entities(&title);
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

fn extract_attribute(tag: &str, attr_name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    // Try double quotes
    let pattern_dq = format!("{}=\"", attr_name);
    if let Some(pos) = lower.find(&pattern_dq) {
        let start = pos + pattern_dq.len();
        if let Some(end) = tag[start..].find('"') {
            return Some(tag[start..start + end].to_string());
        }
    }
    // Try single quotes
    let pattern_sq = format!("{}='", attr_name);
    if let Some(pos) = lower.find(&pattern_sq) {
        let start = pos + pattern_sq.len();
        if let Some(end) = tag[start..].find('\'') {
            return Some(tag[start..start + end].to_string());
        }
    }
    None
}

pub fn parse_ogp(html: &str, url: &str) -> OgpData {
    let title = extract_og_meta(html, "title").or_else(|| extract_title_tag(html));
    let description = extract_og_meta(html, "description");
    let image = extract_og_meta(html, "image");
    let site_name = extract_og_meta(html, "site_name");

    OgpData {
        title,
        description,
        image,
        site_name,
        url: url.to_string(),
    }
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn fetch_ogp(
    url: String,
    cache: tauri::State<'_, std::sync::Arc<std::sync::Mutex<OgpCache>>>,
) -> Result<OgpData, String> {
    // Validate URL
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http and https URLs are supported".to_string());
    }

    // Check cache
    {
        let cache_guard = cache.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = cache_guard.get(&url) {
            return Ok(cached.clone());
        }
    }

    // Fetch URL
    let response = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    let content_type = response.content_type().to_string();
    if !content_type.contains("text/html") && !content_type.contains("application/xhtml") {
        return Err(format!("Unsupported content type: {}", content_type));
    }

    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_BODY_BYTES as u64)
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let ogp = parse_ogp(&body, &url);

    // Cache the result
    {
        let mut cache_guard = cache.lock().map_err(|e| e.to_string())?;
        cache_guard.insert(url, ogp.clone());
    }

    Ok(ogp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ogp_normal() {
        let html = r#"
        <html>
        <head>
            <meta property="og:title" content="Test Title">
            <meta property="og:description" content="Test Description">
            <meta property="og:image" content="https://example.com/image.png">
            <meta property="og:site_name" content="Example Site">
            <title>Fallback Title</title>
        </head>
        </html>
        "#;
        let ogp = parse_ogp(html, "https://example.com");
        assert_eq!(ogp.title, Some("Test Title".to_string()));
        assert_eq!(ogp.description, Some("Test Description".to_string()));
        assert_eq!(
            ogp.image,
            Some("https://example.com/image.png".to_string())
        );
        assert_eq!(ogp.site_name, Some("Example Site".to_string()));
        assert_eq!(ogp.url, "https://example.com");
    }

    #[test]
    fn test_parse_ogp_title_fallback() {
        let html = r#"
        <html>
        <head>
            <title>Fallback Title</title>
        </head>
        </html>
        "#;
        let ogp = parse_ogp(html, "https://example.com");
        assert_eq!(ogp.title, Some("Fallback Title".to_string()));
        assert!(ogp.description.is_none());
        assert!(ogp.image.is_none());
    }

    #[test]
    fn test_parse_ogp_html_entities() {
        let html = r#"
        <html>
        <head>
            <meta property="og:title" content="Title &amp; More &lt;3&gt;">
            <meta property="og:description" content="It&#39;s &quot;great&quot;">
        </head>
        </html>
        "#;
        let ogp = parse_ogp(html, "https://example.com");
        assert_eq!(ogp.title, Some("Title & More <3>".to_string()));
        assert_eq!(ogp.description, Some("It's \"great\"".to_string()));
    }

    #[test]
    fn test_parse_ogp_empty_html() {
        let ogp = parse_ogp("", "https://example.com");
        assert!(ogp.title.is_none());
        assert!(ogp.description.is_none());
        assert!(ogp.image.is_none());
        assert!(ogp.site_name.is_none());
    }

    #[test]
    fn test_parse_ogp_no_head() {
        let html = "<html><body>Hello</body></html>";
        let ogp = parse_ogp(html, "https://example.com");
        assert!(ogp.title.is_none());
    }

    #[test]
    fn test_parse_ogp_single_quotes() {
        let html = r#"
        <html>
        <head>
            <meta property='og:title' content='Single Quote Title'>
        </head>
        </html>
        "#;
        let ogp = parse_ogp(html, "https://example.com");
        assert_eq!(ogp.title, Some("Single Quote Title".to_string()));
    }

    #[test]
    fn test_cache_basic() {
        let mut cache = OgpCache::new();
        let data = OgpData {
            title: Some("Test".to_string()),
            description: None,
            image: None,
            site_name: None,
            url: "https://example.com".to_string(),
        };
        cache.insert("https://example.com".to_string(), data);
        assert!(cache.get("https://example.com").is_some());
        assert!(cache.get("https://other.com").is_none());
    }

    #[test]
    fn test_cache_eviction() {
        let mut cache = OgpCache::new();
        for i in 0..MAX_CACHE_ENTRIES + 5 {
            let url = format!("https://example.com/{}", i);
            let data = OgpData {
                title: Some(format!("Title {}", i)),
                description: None,
                image: None,
                site_name: None,
                url: url.clone(),
            };
            cache.insert(url, data);
        }
        assert!(cache.entries.len() <= MAX_CACHE_ENTRIES);
    }
}
