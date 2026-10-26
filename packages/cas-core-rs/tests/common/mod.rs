//! Test support: a minimal blocking HTTP server that serves a `packBuild`
//! repository with the same URL shape as `tools/cas.mjs serve` /
//! production CDN endpoints. No dependencies, HTTP/1.0, Connection: close.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread;

pub struct FixtureServer {
    pub base: String,
    #[allow(dead_code)] // kept alive so Drop documents the lifecycle; joining would block forever
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        // the accept loop dies when the listener (owned by this struct) drops
    }
}

fn resolve(repo: &Path, path: &str) -> PathBuf {
    let rel = path.trim_start_matches('/');
    match rel.strip_prefix("objects/") {
        Some(id) if id.len() == 64 => {
            repo.join("objects").join(&id[..2]).join(id)
        }
        _ => repo.join(rel),
    }
}

/// Bind on an OS-chosen port and serve `repo` until the TestServer drops.
pub fn spawn(repo: &Path) -> FixtureServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
    let port = listener.local_addr().unwrap().port();
    let repo = repo.to_path_buf();

    let handle = thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let repo = repo.clone();
            thread::spawn(move || {
                let mut conn = stream;
                let mut buf = [0u8; 4096];
                let n = conn.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();

                // keep-alive probe requests to /healthz are cheap to fake
                let resolved = resolve(&repo, &path);
                let body = std::fs::read(&resolved);

                let resp = match body {
                    Ok(data) => {
                        let head = format!(
                            "HTTP/1.0 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            data.len()
                        );
                        let mut full = head.into_bytes();
                        full.extend_from_slice(&data);
                        full
                    }
                    Err(_) => b"HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_vec(),
                };
                let _ = conn.write_all(&resp);
            });
        }
    });

    FixtureServer {
        base: format!("http://127.0.0.1:{port}"),
        handle: Some(handle),
    }
}
