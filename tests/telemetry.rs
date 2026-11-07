use deser::Deserialize;
use deser_value::Value;
use stats_producer::{Producer, ProducerConfig};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tansu::api::handle_v2_api;
use tansu::api_types::V2NotePrecondition;
use tansu::app::App;
use tansu::config::{Config, VaultConfig};
use tansu::http::HttpRequest;
use tansu::telemetry::{self, Telemetry};

#[derive(Deserialize)]
#[deser(deny_unknown_fields)]
struct CapturedEvent {
    #[deser(rename = "schemaVersion")]
    schema_version: u8,
    #[deser(rename = "eventId")]
    event_id: String,
    #[deser(rename = "atMs")]
    at_ms: u64,
    operation: String,
    outcome: String,
    #[deser(rename = "durationMs")]
    duration_ms: u64,
    work: BTreeMap<String, u64>,
    release: String,
    service: String,
    #[deser(default)]
    instance: Option<String>,
    #[deser(default)]
    host: Option<String>,
    #[deser(default)]
    trace: Option<Value>,
}

#[derive(Deserialize)]
#[deser(deny_unknown_fields)]
struct CapturedBatch {
    events: Vec<CapturedEvent>,
}

fn read_request(stream: &mut TcpStream) -> Option<Vec<u8>> {
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut data = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            return None;
        }
        data.extend_from_slice(&buffer[..read]);
        if let Some(index) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&data[..index + 4]).to_ascii_lowercase();
            let length = headers.lines().find_map(|line| line.strip_prefix("content-length:")).and_then(|value| value.trim().parse::<usize>().ok()).unwrap_or(0);
            while data.len() < index + 4 + length {
                let read = stream.read(&mut buffer).ok()?;
                if read == 0 {
                    break;
                }
                data.extend_from_slice(&buffer[..read]);
            }
            return Some(data[index + 4..].to_vec());
        }
    }
}

fn fake_stats() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let stored = Arc::clone(&bodies);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            if let Some(body) = read_request(&mut stream) {
                stored.lock().unwrap().push(String::from_utf8_lossy(&body).into_owned());
            }
            let body = br#"{"accepted":4,"duplicate":0}"#;
            let head = format!("HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    (endpoint, bodies)
}

fn request(method: &str, path: String, server: &str, body: Vec<u8>) -> HttpRequest {
    HttpRequest {
        method: method.to_string(),
        path,
        headers: vec![("X-Tansu-Server-Instance".to_string(), server.to_string())],
        body,
    }
}

#[test]
fn a_note_save_and_search_publish_operation_records_with_the_release() {
    let (endpoint, bodies) = fake_stats();
    let producer = Producer::new(ProducerConfig::new(endpoint, "tansu", "test-token", "test-release")).unwrap();
    assert!(telemetry::init_with(Telemetry::new(producer)));

    let root = tempfile::tempdir().unwrap();
    let vault_root = root.path().join("vault");
    fs::create_dir_all(&vault_root).unwrap();
    fs::write(vault_root.join("one.md"), "# One\n\nalpha\n").unwrap();
    let app = App::new(Config {
        data_root: root.path().join("data"),
        vaults: vec![VaultConfig { name: "Notes".to_string(), path: vault_root }],
        auth: None,
    })
    .unwrap();
    let server = app.server_instance_id().to_string();
    let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();
    let vault = app.vault_by_id(&vault_id).unwrap();
    let note_id = vault.v2_notes().unwrap()[0].note_id.clone();
    let original = vault.v2_open_note(&note_id).unwrap();

    let content = "# One\n\nalpha changed\n";
    let precondition = V2NotePrecondition {
        base_revision: original.meta.revision,
        base_source_hash: original.meta.source_hash.clone(),
        base_disk_hash: original.meta.disk_hash.clone(),
    };
    let save_body = deser_json::to_string(&deser_value::value!({
        "mutationId": "telemetry-save",
        "precondition": deser_value::to_value(&precondition).unwrap(),
        "content": content,
        "sourceHash": tansu_note_core::source_hash(content)
    }))
    .unwrap();
    let saved = handle_v2_api(&app, &request("PUT", format!("/api/v2/vaults/{vault_id}/notes/{note_id}"), &server, save_body.into_bytes()), "save");
    assert_eq!(saved.status(), 200, "{}", String::from_utf8_lossy(saved.body()));

    let search = handle_v2_api(
        &app,
        &request(
            "POST",
            format!("/api/v2/vaults/{vault_id}/search"),
            &server,
            br#"{"query":"alpha","mode":"default","limit":10,"overlays":[]}"#.to_vec(),
        ),
        "search",
    );
    assert_eq!(search.status(), 200, "{}", String::from_utf8_lossy(search.body()));

    telemetry::flush();
    telemetry::shutdown();

    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1, "{bodies:?}");
    let batch: CapturedBatch = deser_json::from_str(&bodies[0]).unwrap();
    assert!(batch.events.iter().all(|event| event.schema_version == 1 && event.release == "test-release" && event.service == "tansu"));
    let save = batch.events.iter().find(|event| event.operation == "note.save").expect("note.save record");
    assert_eq!(save.outcome, "ok");
    assert!(save.work.get("content_bytes").is_some_and(|bytes| *bytes > 0));
    let search = batch.events.iter().find(|event| event.operation == "note.search").expect("note.search record");
    assert_eq!(search.outcome, "ok");
    assert!(search.work.contains_key("results"));
    assert!(batch.events.iter().any(|event| event.operation.starts_with("http.vaults.notes.")));
    assert!(batch.events.iter().any(|event| event.operation == "http.vaults.search"));
}
