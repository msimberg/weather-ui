use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// Hard bound on cached entries. A single location view costs at most
/// 32 upstream-derived entries (forecast + geocode + 30 past days), so this
/// covers well over a hundred distinct locations before evictions kick in.
const MAX_ENTRIES: usize = 4096;

struct Entry {
    value: Value,
    /// None means the entry is immutable (finished past days do not change).
    expires: Option<Instant>,
}

pub struct Cache {
    inner: Mutex<HashMap<String, Entry>>,
}

impl Cache {
    pub fn new() -> Cache {
        Cache {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        let mut map = self.inner.lock().expect("cache lock poisoned");
        match map.get(key) {
            Some(e) if e.expires.is_some_and(|t| t <= Instant::now()) => {
                map.remove(key);
                None
            }
            Some(e) => Some(e.value.clone()),
            None => None,
        }
    }

    pub fn insert(&self, key: String, value: Value, ttl: Option<Duration>) {
        let mut map = self.inner.lock().expect("cache lock poisoned");
        if map.len() >= MAX_ENTRIES {
            let now = Instant::now();
            map.retain(|_, e| e.expires.is_none_or(|t| t > now));
            if map.len() >= MAX_ENTRIES {
                tracing::warn!(entries = map.len(), "cache full; clearing all entries");
                map.clear();
            }
        }
        map.insert(
            key,
            Entry {
                value,
                expires: ttl.map(|d| Instant::now() + d),
            },
        );
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().expect("cache lock poisoned").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_inserted_value_before_ttl() {
        let cache = Cache::new();
        cache.insert(
            "a".into(),
            serde_json::json!(1),
            Some(Duration::from_secs(60)),
        );
        assert_eq!(cache.get("a"), Some(serde_json::json!(1)));
    }

    #[test]
    fn expired_entry_is_evicted() {
        let cache = Cache::new();
        cache.insert(
            "a".into(),
            serde_json::json!(1),
            Some(Duration::from_millis(1)),
        );
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(cache.get("a"), None);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn none_ttl_means_permanent() {
        let cache = Cache::new();
        cache.insert("a".into(), serde_json::json!(1), None);
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(cache.get("a"), Some(serde_json::json!(1)));
    }
}
