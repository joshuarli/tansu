use deser::Deserialize;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Deserialize)]
struct Receipt {
    marker: Option<Marker>,
}

#[derive(Deserialize)]
struct Marker {
    id: String,
    version: String,
    status: String,
}

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/deploy-state.sh")
}

fn write_receipt(path: &Path, revision: &str) {
    fs::write(
        path,
        format!("{{\"revision\":\"{revision}\",\"previousRevision\":\"\",\"release\":\"/opt/tansu/releases/{revision}\",\"updatedAtMs\":1}}\n"),
    )
    .unwrap();
}

fn read_marker(path: &Path) -> Marker {
    let receipt: Receipt = deser_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    receipt.marker.unwrap()
}

fn calls(path: &Path) -> Vec<String> {
    fs::read_to_string(path).unwrap_or_default().lines().map(str::to_owned).collect()
}

fn run(mode: &str, state: &Path, statsctl: &Path, token: &Path, calls_file: &Path, exit: &str) -> Output {
    Command::new("sh")
        .arg(script())
        .arg(mode)
        .arg("--state")
        .arg(state)
        .arg("--statsctl")
        .arg(statsctl)
        .arg("--token-file")
        .arg(token)
        .arg("--origin")
        .arg("http://127.0.0.1:9")
        .arg("--service")
        .arg("tansu")
        .env("CALLS", calls_file)
        .env("FAKE_EXIT", exit)
        .output()
        .unwrap()
}

#[test]
fn a_marker_is_recorded_once_and_a_failed_post_retries_with_the_same_id() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("deploy-state.json");
    let calls_file = root.path().join("calls");
    let token = root.path().join("token.json");
    let statsctl = root.path().join("statsctl");
    fs::write(&token, "{}\n").unwrap();
    fs::write(
        &statsctl,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CALLS\"\nexit \"${FAKE_EXIT:-0}\"\n",
    )
    .unwrap();
    fs::set_permissions(&statsctl, fs::Permissions::from_mode(0o755)).unwrap();
    write_receipt(&state, "aaa");

    let output = run("mark", &state, &statsctl, &token, &calls_file, "0");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let marker = read_marker(&state);
    assert_eq!(marker.version, "aaa");
    assert_eq!(marker.status, "recorded");
    assert_eq!(calls(&calls_file).len(), 1);
    assert!(calls(&calls_file)[0].contains(&marker.id));

    let output = run("mark", &state, &statsctl, &token, &calls_file, "0");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(calls(&calls_file).len(), 1);

    write_receipt(&state, "bbb");
    let output = run("mark", &state, &statsctl, &token, &calls_file, "0");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let marker = read_marker(&state);
    assert_eq!(marker.version, "bbb");
    assert_eq!(marker.status, "recorded");
    assert_eq!(calls(&calls_file).len(), 2);

    write_receipt(&state, "ccc");
    let output = run("mark", &state, &statsctl, &token, &calls_file, "4");
    assert!(!output.status.success());
    let pending = read_marker(&state);
    assert_eq!(pending.version, "ccc");
    assert_eq!(pending.status, "pending");
    assert_eq!(calls(&calls_file).len(), 3);

    let output = run("sync", &state, &statsctl, &token, &calls_file, "0");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let recorded = read_marker(&state);
    assert_eq!(recorded.status, "recorded");
    assert_eq!(recorded.id, pending.id);
    assert_eq!(calls(&calls_file).len(), 4);
    assert!(calls(&calls_file)[3].contains(&pending.id));
}
