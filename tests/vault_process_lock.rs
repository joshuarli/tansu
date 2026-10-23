use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tansu::api_types::{AppSettings, AppVaultSettings};
use tansu::config::ConfigStore;

struct ServerConfig {
    config_home: PathBuf,
    data_home: PathBuf,
}

struct RunningServer {
    child: ChildGuard,
    output: Receiver<String>,
    reader: Option<JoinHandle<()>>,
}

struct ChildGuard {
    child: Child,
    finished: bool,
}

enum ProcessOutput {
    Line(String),
    Closed,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self {
            child,
            finished: false,
        }
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        self.finished |= status.is_some();
        Ok(status)
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.finished = true;
        Ok(status)
    }

    fn terminate(&mut self) -> std::io::Result<ExitStatus> {
        if !self.finished {
            let _ = self.child.kill();
        }
        self.wait()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.terminate();
        }
    }
}

impl RunningServer {
    fn start(config: &ServerConfig) -> Self {
        let mut child = ChildGuard::new(
            server_command(config)
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let stdout = child.child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        let mut server = Self {
            child,
            output,
            reader: Some(reader),
        };
        server.wait_until_listening();
        server
    }

    fn wait_until_listening(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.output.recv_timeout(remaining) {
                Ok(line) => {
                    if is_listening_event(&line) {
                        return;
                    }
                }
                Err(error) => panic!("server did not report listening: {error}"),
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!("server exited before listening: {status}");
            }
        }
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.terminate();
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
    }
}

fn server_command(config: &ServerConfig) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tansu"));
    command
        .args(["--port", "0"])
        .env("XDG_CONFIG_HOME", &config.config_home)
        .env("XDG_DATA_HOME", &config.data_home)
        .env("TANSU_LOGS", "pretty");
    command
}

fn is_listening_event(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .is_ok_and(|event| event["system"]["action"] == "listen")
}

fn initialize_config(config_home: &Path, vault_root: &Path, name: &str) -> ServerConfig {
    let store = ConfigStore::open(&config_home.join("tansu/settings.sqlite3")).unwrap();
    store
        .initialize_settings(&AppSettings {
            vaults: vec![AppVaultSettings {
                name: name.to_string(),
                path: vault_root.to_string_lossy().into_owned(),
            }],
            auth: None,
        })
        .unwrap();
    ServerConfig {
        config_home: config_home.to_path_buf(),
        data_home: config_home.join("data"),
    }
}

fn assert_second_server_rejected(owner_config: &ServerConfig, contender_config: &ServerConfig) {
    let _owner = RunningServer::start(owner_config);
    let mut child = ChildGuard::new(
        server_command(contender_config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stdout = child.child.stdout.take().unwrap();
    let stderr_stream = child.child.stderr.take().unwrap();
    let (sender, output) = mpsc::channel();
    let stdout_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(ProcessOutput::Line(line)).is_err() {
                return;
            }
        }
        let _ = sender.send(ProcessOutput::Closed);
    });
    let (stderr_sender, stderr_output) = mpsc::channel();
    let stderr_reader = thread::spawn(move || {
        let mut stderr = String::new();
        let _ = BufReader::new(stderr_stream).read_to_string(&mut stderr);
        let _ = stderr_sender.send(stderr);
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match output.recv_timeout(remaining) {
            Ok(ProcessOutput::Line(line)) if is_listening_event(&line) => {
                let status = child.terminate().unwrap();
                stdout_reader.join().unwrap();
                stderr_reader.join().unwrap();
                panic!("contender unexpectedly started listening: {line}; {status}");
            }
            Ok(ProcessOutput::Line(_)) => {}
            Ok(ProcessOutput::Closed) => break child.wait().unwrap(),
            Err(error) => {
                let status = child.terminate().unwrap();
                stdout_reader.join().unwrap();
                stderr_reader.join().unwrap();
                panic!("contender did not exit before the deadline: {error}; {status}");
            }
        }
    };
    stdout_reader.join().unwrap();
    stderr_reader.join().unwrap();
    let stderr = stderr_output.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        !status.success() && stderr.contains("already owned by another Tansu server"),
        "contender did not exit with the vault ownership error: status={status}, stderr={stderr}"
    );
}

#[test]
fn separate_server_processes_reject_the_same_vault_root() {
    let directory = tempfile::tempdir().unwrap();
    let vault_root = directory.path().join("notes");
    std::fs::create_dir_all(&vault_root).unwrap();
    let first = initialize_config(&directory.path().join("config-a"), &vault_root, "Notes");
    let second = initialize_config(&directory.path().join("config-b"), &vault_root, "Notes Copy");

    assert_second_server_rejected(&first, &first);
    assert_second_server_rejected(&first, &second);
}
