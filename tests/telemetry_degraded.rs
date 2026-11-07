use stats_producer::{Producer, ProducerConfig};
use std::fs;
use tansu::api::handle_v2_api;
use tansu::api_types::V2NotePrecondition;
use tansu::app::App;
use tansu::config::{Config, VaultConfig};
use tansu::http::HttpRequest;
use tansu::telemetry::{self, Telemetry};

#[test]
fn a_save_succeeds_when_stats_is_unreachable_and_drops_stay_bounded() {
    let producer = Producer::new(ProducerConfig::new("http://127.0.0.1:1", "tansu", "test-token", "test-release")).unwrap();
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
    let body = deser_json::to_string(&deser_value::value!({
        "mutationId": "degraded-save",
        "precondition": deser_value::to_value(&precondition).unwrap(),
        "content": content,
        "sourceHash": tansu_note_core::source_hash(content)
    }))
    .unwrap();
    let saved = handle_v2_api(
        &app,
        &HttpRequest {
            method: "PUT".to_string(),
            path: format!("/api/v2/vaults/{vault_id}/notes/{note_id}"),
            headers: vec![("X-Tansu-Server-Instance".to_string(), server)],
            body: body.into_bytes(),
        },
        "save",
    );
    assert_eq!(saved.status(), 200, "{}", String::from_utf8_lossy(saved.body()));

    let _ = telemetry::flush();
    let dropped = telemetry::dropped();
    assert!(dropped > 0, "the unreachable endpoint should drop at least one event");
    assert!(dropped <= 1024, "drops must stay within the bounded queue, got {dropped}");
    assert!(telemetry::last_error().is_some());
    telemetry::shutdown();
}
