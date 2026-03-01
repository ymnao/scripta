use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
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
        // Remove expired entries before inserting to keep the cache healthy
        self.entries
            .retain(|_, entry| entry.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS);
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
    // &amp; must be decoded LAST to prevent double-decoding
    // (e.g. &amp;lt; → &lt; → < if &amp; were first)
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
        .replace("&amp;", "&")
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
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?.checked_add(6)?;
    let rest = &lower[start..];
    // Skip past the closing '>' of the opening tag
    let content_start = rest.find('>')? + 1;
    let content_rest = &html[start + content_start..];
    let end = content_rest.to_ascii_lowercase().find("</title>")?;
    let title = content_rest[..end].trim().to_string();
    let decoded = decode_html_entities(&title);
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

fn extract_attribute(tag: &str, attr_name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
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

/// Allowlist approach: returns true only for globally routable IPs.
/// Mirrors the logic of the unstable `Ipv4Addr::is_global()` / `Ipv6Addr::is_global()`
/// plus additional special-purpose ranges from IANA registries.
fn is_global_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            !(octets[0] == 0              // 0.0.0.0/8 ("This network")
                || v4.is_loopback()       // 127.0.0.0/8
                || v4.is_private()        // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local()     // 169.254/16
                || (octets[0] == 100 && (octets[1] & 0xc0) == 64)  // 100.64.0.0/10 (CGNAT)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)  // 192.0.0.0/24 (IETF)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)  // 192.0.2.0/24 (TEST-NET-1)
                || (octets[0] == 198 && (octets[1] & 0xfe) == 18)  // 198.18.0.0/15 (benchmarking)
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100) // 198.51.100.0/24 (TEST-NET-2)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)  // 203.0.113.0/24 (TEST-NET-3)
                || (octets[0] & 0xf0) == 224  // 224.0.0.0/4 (multicast)
                || octets[0] >= 240)      // 240.0.0.0/4 (reserved + broadcast)
        }
        IpAddr::V6(v6) => {
            let segs = v6.segments();
            // Must be global unicast (2000::/3) ...
            (segs[0] & 0xe000) == 0x2000
                // ... but exclude special-purpose prefixes within 2000::/3:
                && !((segs[0] == 0x2001) && (segs[1] == 0x0db8))  // 2001:db8::/32 (documentation)
                && !((segs[0] == 0x2001) && (segs[1] < 0x0200))   // 2001::/23 (IETF protocol assignments)
                && !((segs[0] == 0x2002))                          // 2002::/16 (6to4, deprecated)
        }
    }
}

/// Custom DNS resolver that only allows globally routable IPs.
/// This prevents DNS rebinding attacks by validating IPs at the point of
/// connection, not as a separate check-then-use step.
struct SsrfSafeResolver;

impl ureq::Resolver for SsrfSafeResolver {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
        for addr in &addrs {
            if !is_global_ip(addr.ip()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "Access to non-global network address is not allowed: {}",
                        addr.ip()
                    ),
                ));
            }
        }
        Ok(addrs)
    }
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
    // Validate URL scheme (case-insensitive)
    let lower_url = url.to_ascii_lowercase();
    if !lower_url.starts_with("http://") && !lower_url.starts_with("https://") {
        return Err("Only http and https URLs are supported".to_string());
    }

    // Check cache first (avoids unnecessary DNS resolution)
    {
        let cache_guard = cache.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = cache_guard.get(&url) {
            return Ok(cached.clone());
        }
    }

    // Fetch URL with SSRF-safe resolver.
    // SsrfSafeResolver validates IPs at DNS resolution time, preventing
    // DNS rebinding (TOCTOU) attacks. Redirects are also safe because
    // each redirect target goes through the same resolver.
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(5))
        .resolver(SsrfSafeResolver)
        .build();

    let response = agent
        .get(&url)
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
    fn test_decode_html_entities_no_double_decode() {
        // &amp;lt; should decode to &lt; (not <)
        assert_eq!(decode_html_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_html_entities("&amp;amp;"), "&amp;");
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
    fn test_is_global_ip_v4_rejects_non_global() {
        use std::net::Ipv4Addr;
        // Loopback
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        // Private ranges
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        // Link-local
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));
        // 0.0.0.0/8 ("This network") — entire range, not just 0.0.0.0
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(0, 1, 2, 3))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(0, 255, 255, 255))));
        // Multicast (224.0.0.0/4)
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(239, 255, 255, 255))));
        // CGNAT (100.64.0.0/10)
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(100, 127, 255, 254))));
        // Documentation ranges
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1))));    // TEST-NET-1
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 1)))); // TEST-NET-2
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1))));  // TEST-NET-3
        // Benchmarking (198.18.0.0/15)
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(198, 19, 255, 1))));
        // Reserved (240+)
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(240, 0, 0, 1))));
        assert!(!is_global_ip(IpAddr::V4(Ipv4Addr::new(255, 255, 255, 255))));
    }

    #[test]
    fn test_is_global_ip_v4_allows_public() {
        use std::net::Ipv4Addr;
        assert!(is_global_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(is_global_ip(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))));
        assert!(is_global_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        // Edge: 100.63.x.x is NOT CGNAT, should be allowed
        assert!(is_global_ip(IpAddr::V4(Ipv4Addr::new(100, 63, 255, 255))));
    }

    #[test]
    fn test_is_global_ip_v6() {
        use std::net::Ipv6Addr;
        // Non-global
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
        // ULA (fc00::/7)
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1))));
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1))));
        // Link-local (fe80::/10)
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1))));
        // Documentation (2001:db8::/32)
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 1))));
        // IETF protocol assignments (2001::/23)
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::new(0x2001, 0x0000, 0, 0, 0, 0, 0, 1))));
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::new(0x2001, 0x01ff, 0, 0, 0, 0, 0, 1))));
        // 6to4 (2002::/16, deprecated)
        assert!(!is_global_ip(IpAddr::V6(Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 1))));
        // Global unicast (2000::/3)
        assert!(is_global_ip(IpAddr::V6(Ipv6Addr::new(0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888))));
        assert!(is_global_ip(IpAddr::V6(Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111))));
    }

    #[test]
    fn test_ssrf_safe_resolver_blocks_private() {
        use ureq::Resolver;
        let resolver = SsrfSafeResolver;
        // localhost
        assert!(resolver.resolve("127.0.0.1:80").is_err());
        // IPv6 loopback
        assert!(resolver.resolve("[::1]:80").is_err());
    }

    #[test]
    fn test_ssrf_safe_resolver_allows_public() {
        use ureq::Resolver;
        let resolver = SsrfSafeResolver;
        // Public DNS (8.8.8.8)
        assert!(resolver.resolve("8.8.8.8:80").is_ok());
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
