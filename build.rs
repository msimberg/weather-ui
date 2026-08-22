// Build metadata for the binary: version comes from Cargo.toml (via
// CARGO_PKG_VERSION at compile time), commit from git describe when the
// .git dir is present (local/dev builds) or GIT_SHA env var (docker builds
// copy sources without .git), build date from SOURCE_DATE_EPOCH when set
// (reproducible builds) else the current UTC time.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let commit = git_describe()
        .unwrap_or_else(|| std::env::var("GIT_SHA").unwrap_or_else(|_| "unknown".to_string()));
    println!("cargo:rustc-env=BUILD_COMMIT={commit}");

    let epoch = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        });
    println!("cargo:rustc-env=BUILD_DATE={}", ymd_hm(epoch));

    // Re-run when sources or the env overrides change.
    println!("cargo:rerun-if-env-changed=GIT_SHA");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-changed=src");
}

fn git_describe() -> Option<String> {
    let out = Command::new("git")
        .args(["describe", "--tags", "--always", "--dirty"])
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Days-after-epoch to YYYY-MM-DD HH:MM UTC (same formula as the meteoblue
/// ISO parser; no chrono dep needed for just this).
fn ymd_hm(epoch: u64) -> String {
    let days = (epoch / 86_400) as i64;
    let secs_of_day = (epoch % 86_400) as i64;
    // Hinnant civil-from-days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    format!("{year:04}-{m:02}-{d:02} {hh:02}:{mm:02}Z")
}
