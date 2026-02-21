use notify::event::EventKind;
#[cfg(feature = "tauri-app")]
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(feature = "tauri-app")]
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
#[cfg(feature = "tauri-app")]
use std::sync::mpsc;
#[cfg(feature = "tauri-app")]
use std::thread;
#[cfg(feature = "tauri-app")]
use std::time::{Duration, Instant};

#[cfg(feature = "tauri-app")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEvent {
    pub kind: String,
    pub path: String,
}

#[cfg(feature = "tauri-app")]
pub struct WatcherState {
    watcher: Option<RecommendedWatcher>,
    stop_tx: Option<mpsc::Sender<()>>,
    thread_handle: Option<thread::JoinHandle<()>>,
}

#[cfg(feature = "tauri-app")]
impl WatcherState {
    pub fn new() -> Self {
        Self {
            watcher: None,
            stop_tx: None,
            thread_handle: None,
        }
    }

    pub fn start(&mut self, path: &str, app_handle: tauri::AppHandle) -> Result<(), String> {
        use tauri::Emitter;

        self.stop();

        let (event_tx, event_rx) = mpsc::channel::<notify::Event>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = event_tx.send(event);
                }
            },
            notify::Config::default(),
        )
        .map_err(|e| e.to_string())?;

        watcher
            .watch(Path::new(path), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        self.watcher = Some(watcher);
        self.stop_tx = Some(stop_tx);

        let handle = thread::spawn(move || {
            let batch_duration = Duration::from_millis(500);
            let poll_interval = Duration::from_millis(50);
            let mut pending: HashMap<String, String> = HashMap::new();
            let mut deadline: Option<Instant> = None;

            let mut stopped = false;

            loop {
                if stop_rx.try_recv().is_ok() {
                    stopped = true;
                    break;
                }

                match event_rx.recv_timeout(poll_interval) {
                    Ok(event) => {
                        if let Some(kind_str) = map_event_kind(&event.kind) {
                            for path in &event.paths {
                                if is_hidden(path) {
                                    continue;
                                }
                                let path_str = path.to_string_lossy().to_string();
                                merge_event_kind(&mut pending, path_str, kind_str);
                            }
                            if !pending.is_empty() && deadline.is_none() {
                                deadline = Some(Instant::now() + batch_duration);
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if let Some(dl) = deadline {
                    if Instant::now() >= dl {
                        reclassify_deleted(&mut pending);
                        let events: Vec<FsChangeEvent> = pending
                            .drain()
                            .map(|(path, kind)| FsChangeEvent { kind, path })
                            .collect();
                        if !events.is_empty() {
                            let _ = app_handle.emit("fs-change", &events);
                        }
                        deadline = None;
                    }
                }
            }

            // Flush remaining events only on disconnect (not on explicit stop,
            // to avoid emitting stale events from a previous workspace).
            if !stopped && !pending.is_empty() {
                reclassify_deleted(&mut pending);
                let events: Vec<FsChangeEvent> = pending
                    .drain()
                    .map(|(path, kind)| FsChangeEvent { kind, path })
                    .collect();
                let _ = app_handle.emit("fs-change", &events);
            }
        });
        self.thread_handle = Some(handle);

        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        // Drop the watcher first so no new filesystem events are generated,
        // then join the aggregator thread to ensure it has fully stopped
        // before a new watcher can be started (prevents stale event leaks).
        self.watcher = None;
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn is_hidden(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// Reclassify "modify" events for paths that no longer exist as "delete".
/// macOS FSEvents may report file deletions as modify events.
pub fn reclassify_deleted(pending: &mut HashMap<String, String>) {
    let deleted_paths: Vec<String> = pending
        .iter()
        .filter(|(path, kind)| kind.as_str() == "modify" && !Path::new(path.as_str()).exists())
        .map(|(path, _)| path.clone())
        .collect();
    for path in deleted_paths {
        pending.insert(path, "delete".to_string());
    }
}

/// Merge a new event kind into the pending map, respecting kind transitions:
/// - create + modify → create (modification is part of creation)
/// - create + delete → remove entry (net no-op)
/// - delete + create → modify (re-creation)
/// - other combinations → latest kind wins
pub fn merge_event_kind(pending: &mut HashMap<String, String>, path: String, kind: &str) {
    match pending.get(&path).map(|s| s.as_str()) {
        Some("create") if kind == "modify" => {} // keep create
        Some("create") if kind == "delete" => {
            pending.remove(&path);
        }
        Some("delete") if kind == "create" => {
            pending.insert(path, "modify".to_string());
        }
        _ => {
            pending.insert(path, kind.to_string());
        }
    }
}

pub fn map_event_kind(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("create"),
        EventKind::Modify(_) => Some("modify"),
        EventKind::Remove(_) => Some("delete"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn test_is_hidden_normal_path() {
        assert!(!is_hidden(Path::new("/home/user/docs/file.md")));
    }

    #[test]
    fn test_is_hidden_git_directory() {
        assert!(is_hidden(Path::new("/home/user/project/.git/config")));
    }

    #[test]
    fn test_is_hidden_hidden_file() {
        assert!(is_hidden(Path::new("/home/user/.hidden")));
    }

    #[test]
    fn test_is_hidden_dotfile_in_subdir() {
        assert!(is_hidden(Path::new("/project/.config/settings.json")));
    }

    #[test]
    fn test_map_event_kind_create() {
        assert_eq!(
            map_event_kind(&EventKind::Create(CreateKind::File)),
            Some("create")
        );
    }

    #[test]
    fn test_map_event_kind_modify() {
        assert_eq!(
            map_event_kind(&EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Content
            ))),
            Some("modify")
        );
    }

    #[test]
    fn test_map_event_kind_remove() {
        assert_eq!(
            map_event_kind(&EventKind::Remove(RemoveKind::File)),
            Some("delete")
        );
    }

    #[test]
    fn test_map_event_kind_access() {
        assert_eq!(map_event_kind(&EventKind::Access(AccessKind::Read)), None);
    }

    #[test]
    fn test_map_event_kind_other() {
        assert_eq!(map_event_kind(&EventKind::Other), None);
    }

    #[test]
    fn test_merge_create_then_modify_keeps_create() {
        let mut pending = HashMap::new();
        merge_event_kind(&mut pending, "/a.md".into(), "create");
        merge_event_kind(&mut pending, "/a.md".into(), "modify");
        assert_eq!(pending.get("/a.md").unwrap(), "create");
    }

    #[test]
    fn test_merge_create_then_delete_removes_entry() {
        let mut pending = HashMap::new();
        merge_event_kind(&mut pending, "/a.md".into(), "create");
        merge_event_kind(&mut pending, "/a.md".into(), "delete");
        assert!(!pending.contains_key("/a.md"));
    }

    #[test]
    fn test_merge_delete_then_create_becomes_modify() {
        let mut pending = HashMap::new();
        merge_event_kind(&mut pending, "/a.md".into(), "delete");
        merge_event_kind(&mut pending, "/a.md".into(), "create");
        assert_eq!(pending.get("/a.md").unwrap(), "modify");
    }

    #[test]
    fn test_merge_modify_then_delete_becomes_delete() {
        let mut pending = HashMap::new();
        merge_event_kind(&mut pending, "/a.md".into(), "modify");
        merge_event_kind(&mut pending, "/a.md".into(), "delete");
        assert_eq!(pending.get("/a.md").unwrap(), "delete");
    }

    #[test]
    fn test_reclassify_deleted_nonexistent_path() {
        let mut pending = HashMap::new();
        pending.insert("/nonexistent/file.md".to_string(), "modify".to_string());
        reclassify_deleted(&mut pending);
        assert_eq!(pending.get("/nonexistent/file.md").unwrap(), "delete");
    }

    #[test]
    fn test_reclassify_deleted_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("exists.md");
        std::fs::write(&file_path, "content").unwrap();
        let path_str = file_path.to_string_lossy().to_string();

        let mut pending = HashMap::new();
        pending.insert(path_str.clone(), "modify".to_string());
        reclassify_deleted(&mut pending);
        assert_eq!(pending.get(&path_str).unwrap(), "modify");
    }

    #[test]
    fn test_reclassify_deleted_skips_non_modify() {
        let mut pending = HashMap::new();
        pending.insert("/nonexistent/file.md".to_string(), "create".to_string());
        reclassify_deleted(&mut pending);
        // create should NOT be reclassified, even if path doesn't exist
        assert_eq!(pending.get("/nonexistent/file.md").unwrap(), "create");
    }
}
