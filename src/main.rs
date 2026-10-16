use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tansu2::app::App;
use tansu2::api_types::{AppAuthSettings, AppSettings, AppVaultSettings};
use tansu2::auth::{AuthError, AuthStore};
use tansu2::config::{AuthConfig, Config, ConfigStore, prepare_auth_state_directory};
use tansu2::http::{
    EventEnvelope, EventSource, EventSourceError, EventSubscription, EventSubscriptionStream,
    ServerServices, serve_setup, serve_with_services,
};
use tansu2::vault::{V2EventEnvelope, V2EventSubscription};

const SESSION_TTL_SECS: u64 = 8 * 60 * 60;
const OWNER_VERIFICATION_TTL_SECS: u64 = 5 * 60;
const INITIAL_ENROLLMENT_TTL_SECS: u64 = 10 * 60;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> tansu2::Result<()> {
    match parse_command(std::env::args_os().skip(1))? {
        Command::Serve { port } => {
            let store = ConfigStore::open_default()?;
            match store.config()? {
                Some(config) => run_server(config, store, port),
                None => run_setup_server(store, port),
            }
        }
        Command::InitializeSettings(settings) => {
            ConfigStore::open_default()?.initialize_settings(&settings)?;
            println!("Application settings saved.");
            Ok(())
        }
        Command::Auth(command) => {
            let config = ConfigStore::open_default()?
                .config()?
                .ok_or_else(|| tansu2::Error::BadRequest("application settings are not configured".to_string()))?;
            let output = run_auth_command(&config, command)?;
            match output {
                AuthCommandOutput::EnrollmentCapability(capability) => println!("{capability}"),
                AuthCommandOutput::Message(message) => println!("{message}"),
            }
            Ok(())
        }
    }
}

fn run_setup_server(store: ConfigStore, port: u16) -> tansu2::Result<()> {
    serve_setup(App::setup_only(store), port)
}

fn run_server(config: Config, store: ConfigStore, port: u16) -> tansu2::Result<()> {
    let auth_config = config.auth.clone();
    let app = App::from_settings(config, store)?;
    let auth = auth_config
        .map(|auth_config| {
            prepare_auth_state_directory(&auth_config)?;
            AuthStore::open(
                auth_config.state_directory(),
                auth_config.policy().clone(),
                SESSION_TTL_SECS,
                OWNER_VERIFICATION_TTL_SECS,
            )
            .map(Arc::new)
            .map_err(auth_error)
        })
        .transpose()?;
    let events: Arc<dyn EventSource> = Arc::new(AppEventSource(app.clone()));
    serve_with_services(
        app,
        port,
        ServerServices {
            auth,
            events: Some(events),
        },
    )
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Serve { port: u16 },
    InitializeSettings(AppSettings),
    Auth(AuthCommand),
}

#[derive(Debug, PartialEq, Eq)]
enum AuthCommand {
    Enroll,
    Backup(PathBuf),
    Restore(PathBuf),
}

enum AuthCommandOutput {
    EnrollmentCapability(String),
    Message(String),
}

fn parse_command(args: impl IntoIterator<Item = OsString>) -> tansu2::Result<Command> {
    let args = args.into_iter().collect::<Vec<_>>();
    match args.as_slice() {
        [] => Ok(Command::Serve { port: 3000 }),
        [flag, port] if flag == "--port" => {
            let port = port
                .to_str()
                .and_then(|port| port.parse().ok())
                .ok_or_else(usage_error)?;
            Ok(Command::Serve { port })
        }
        [config, init, args @ ..] if config == "config" && init == "init" => {
            Ok(Command::InitializeSettings(parse_settings_args(args)?))
        }
        [auth, subcommand] if auth == "auth" && subcommand == "enroll" => {
            Ok(Command::Auth(AuthCommand::Enroll))
        }
        [auth, subcommand, path] if auth == "auth" && subcommand == "backup" => {
            Ok(Command::Auth(AuthCommand::Backup(PathBuf::from(path))))
        }
        [auth, subcommand, path] if auth == "auth" && subcommand == "restore" => {
            Ok(Command::Auth(AuthCommand::Restore(PathBuf::from(path))))
        }
        _ => Err(usage_error()),
    }
}

fn parse_settings_args(args: &[OsString]) -> tansu2::Result<AppSettings> {
    let mut vaults = Vec::new();
    let mut auth = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].to_str() {
            Some("--vault") if index + 2 < args.len() => {
                let name = args[index + 1].to_str().ok_or_else(usage_error)?;
                let path = args[index + 2].to_str().ok_or_else(usage_error)?;
                vaults.push(AppVaultSettings { name: name.to_string(), path: path.to_string() });
                index += 3;
            }
            Some("--auth") if index + 3 < args.len() && auth.is_none() => {
                auth = Some(AppAuthSettings {
                    external_origin: args[index + 1].to_str().ok_or_else(usage_error)?.to_string(),
                    rp_id: args[index + 2].to_str().ok_or_else(usage_error)?.to_string(),
                    rp_name: args[index + 3].to_str().ok_or_else(usage_error)?.to_string(),
                });
                index += 4;
            }
            _ => return Err(usage_error()),
        }
    }
    if vaults.is_empty() {
        return Err(usage_error());
    }
    Ok(AppSettings { vaults, auth })
}

fn usage_error() -> tansu2::Error {
    tansu2::Error::BadRequest(
        "usage: tansu2 [--port PORT] | tansu2 config init --vault NAME PATH [--vault NAME PATH] [--auth ORIGIN RP_ID RP_NAME] | tansu2 auth enroll | tansu2 auth backup PATH | tansu2 auth restore PATH".to_string(),
    )
}

fn run_auth_command(config: &Config, command: AuthCommand) -> tansu2::Result<AuthCommandOutput> {
    let auth_config = config
        .auth
        .as_ref()
        .ok_or_else(|| tansu2::Error::BadRequest("authenticated mode is not configured".into()))?;
    prepare_auth_state_directory(auth_config)?;
    match command {
        AuthCommand::Enroll => create_initial_enrollment(auth_config),
        AuthCommand::Backup(path) => {
            AuthStore::backup_to(auth_config.state_directory(), &path).map_err(auth_error)?;
            Ok(AuthCommandOutput::Message(format!("Auth database backed up to {}", path.display())))
        }
        AuthCommand::Restore(path) => {
            AuthStore::restore_from_backup(auth_config.state_directory(), &path).map_err(auth_error)?;
            Ok(AuthCommandOutput::Message(format!("Auth database restored from {}", path.display())))
        }
    }
}

fn create_initial_enrollment(auth_config: &AuthConfig) -> tansu2::Result<AuthCommandOutput> {
    let auth = AuthStore::open(
        auth_config.state_directory(),
        auth_config.policy().clone(),
        SESSION_TTL_SECS,
        OWNER_VERIFICATION_TTL_SECS,
    )
    .map_err(auth_error)?;
    let (capability, _) = match auth.create_enrollment_capability(unix_time_seconds()?, INITIAL_ENROLLMENT_TTL_SECS) {
        Ok(capability) => capability,
        Err(AuthError::InvalidRequest(message)) if message == "initial enrollment is already complete" => {
            return Err(tansu2::Error::BadRequest(
                "an owner credential already exists; sign in with a passkey before adding another".into(),
            ));
        }
        Err(error) => return Err(auth_error(error)),
    };
    Ok(AuthCommandOutput::EnrollmentCapability(capability))
}

fn unix_time_seconds() -> tansu2::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| tansu2::Error::Internal(error.to_string()))
}

fn auth_error(error: AuthError) -> tansu2::Error {
    tansu2::Error::Internal(error.to_string())
}

struct AppEventSource(App);

impl EventSource for AppEventSource {
    fn subscribe(
        &self,
        vault_id: &str,
        after_event_version: Option<u64>,
    ) -> std::result::Result<EventSubscription, EventSourceError> {
        let vault = self.0.vault_by_id(vault_id).map_err(|error| match error {
            tansu2::Error::NotFound(_) => EventSourceError::VaultNotFound,
            error => EventSourceError::Internal(error.to_string()),
        })?;
        let subscription = vault
            .subscribe_v2_events(after_event_version)
            .map_err(|error| EventSourceError::Internal(error.to_string()))?;
        Ok(EventSubscription {
            replay: subscription.replay.into_iter().map(event_envelope).collect(),
            current_version: subscription.current_version,
            resync_required: subscription.resync_required,
            events: Box::new(AppEventStream(subscription.events)),
        })
    }
}

struct AppEventStream(V2EventSubscription);

impl EventSubscriptionStream for AppEventStream {
    fn capacity(&self) -> usize {
        self.0.capacity()
    }

    fn recv_timeout(
        &mut self,
        timeout: std::time::Duration,
    ) -> std::result::Result<EventEnvelope, std::sync::mpsc::RecvTimeoutError> {
        self.0.recv_timeout(timeout).map(event_envelope)
    }
}

fn event_envelope(event: V2EventEnvelope) -> EventEnvelope {
    EventEnvelope {
        event_version: event.event_version,
        payload: event.payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_and_auth_commands_without_decoding_paths() {
        assert_eq!(parse_command([]).unwrap(), Command::Serve { port: 3000 });
        assert_eq!(
            parse_command(["--port".into(), "4312".into()]).unwrap(),
            Command::Serve { port: 4312 },
        );
        assert_eq!(
            parse_command(["auth".into(), "enroll".into()]).unwrap(),
            Command::Auth(AuthCommand::Enroll),
        );
        assert!(parse_command(["migrate".into()]).is_err());
        let path = OsString::from("backup.db");
        assert_eq!(
            parse_command(["auth".into(), "backup".into(), path.clone()]).unwrap(),
            Command::Auth(AuthCommand::Backup(PathBuf::from(path))),
        );
        assert!(parse_command(["auth".into(), "unknown".into()]).is_err());
    }

    #[test]
    fn parses_app_settings_initialization_command() {
        assert_eq!(
            parse_command([
                "config".into(), "init".into(),
                "--vault".into(), "Notes".into(), "/notes".into(),
                "--vault".into(), "Work".into(), "/work".into(),
                "--auth".into(), "https://notes.example.com".into(),
                "example.com".into(), "Tansu".into(),
            ]).unwrap(),
            Command::InitializeSettings(AppSettings {
                vaults: vec![
                    AppVaultSettings { name: "Notes".into(), path: "/notes".into() },
                    AppVaultSettings { name: "Work".into(), path: "/work".into() },
                ],
                auth: Some(AppAuthSettings {
                    external_origin: "https://notes.example.com".into(),
                    rp_id: "example.com".into(),
                    rp_name: "Tansu".into(),
                }),
            }),
        );
        assert!(parse_command(["config".into(), "init".into()]).is_err());
        assert!(parse_command([
            "config".into(), "init".into(), "--vault".into(), "Notes".into(), "/notes".into(),
            "--auth".into(), "https://notes.example.com".into(), "example.com".into(),
        ]).is_err());
    }

    #[test]
    fn rejects_non_utf8_port_but_preserves_non_utf8_backup_path() {
        {
            use std::os::unix::ffi::OsStringExt;
            let non_utf8 = OsString::from_vec(vec![0xff]);
            assert!(parse_command(["--port".into(), non_utf8.clone()]).is_err());
            assert_eq!(
                parse_command(["auth".into(), "backup".into(), non_utf8.clone()]).unwrap(),
                Command::Auth(AuthCommand::Backup(PathBuf::from(non_utf8))),
            );
        }
    }

}
