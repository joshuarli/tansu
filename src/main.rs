use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tansu::app::App;
use tansu::api_types::{AppAuthSettings, AppSettings, AppVaultSettings};
use tansu::auth::{AuthError, AuthStore};
use tansu::config::{AuthConfig, Config, ConfigStore, prepare_auth_state_directory};
use tansu::http::{
    EventEnvelope, EventSource, EventSourceError, EventSubscription, EventSubscriptionStream,
    ServerServices, serve_setup, serve_with_services,
};
use tansu::vault::{V2EventEnvelope, V2EventSubscription};

const SESSION_TTL_SECS: u64 = 8 * 60 * 60;
const OWNER_VERIFICATION_TTL_SECS: u64 = 5 * 60;
const INITIAL_ENROLLMENT_TTL_SECS: u64 = 10 * 60;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> tansu::Result<()> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if let Some(help) = help_for_args(&args) {
        print!("{help}");
        return Ok(());
    }
    match parse_command(args)? {
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
                .ok_or_else(|| tansu::Error::BadRequest("application settings are not configured".to_string()))?;
            let output = run_auth_command(&config, command)?;
            match output {
                AuthCommandOutput::EnrollmentCapability(capability) => println!("{capability}"),
                AuthCommandOutput::Message(message) => println!("{message}"),
            }
            Ok(())
        }
    }
}

fn run_setup_server(store: ConfigStore, port: u16) -> tansu::Result<()> {
    tansu::telemetry::init();
    let result = serve_setup(App::setup_only(store), port);
    tansu::telemetry::shutdown();
    result
}

fn run_server(config: Config, store: ConfigStore, port: u16) -> tansu::Result<()> {
    tansu::telemetry::init();
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
    let result = serve_with_services(
        app,
        port,
        ServerServices {
            auth,
            events: Some(events),
        },
    );
    tansu::telemetry::shutdown();
    result
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

struct Argument {
    name: &'static str,
    values: &'static str,
    description: &'static str,
    usage: Usage,
    default: Option<u16>,
}

#[derive(Clone, Copy)]
enum Usage { Optional, Required, Repeated }

struct CommandHelp {
    path: &'static [&'static str],
    description: &'static str,
    arguments: &'static [Argument],
    example: &'static [&'static str],
}

const PORT: Argument = Argument { name: "--port", values: "PORT", description: "Listen on this port.", usage: Usage::Optional, default: Some(DEFAULT_PORT) };
const VAULT: Argument = Argument { name: "--vault", values: "NAME PATH", description: "Add a vault (required, repeatable).", usage: Usage::Repeated, default: None };
const AUTH: Argument = Argument { name: "--auth", values: "ORIGIN RP_ID RP_NAME", description: "Configure authentication (optional).", usage: Usage::Optional, default: None };
const BACKUP_PATH: Argument = Argument { name: "PATH", values: "", description: "Destination backup file (required).", usage: Usage::Required, default: None };
const RESTORE_PATH: Argument = Argument { name: "PATH", values: "", description: "Source backup file (required).", usage: Usage::Required, default: None };
const SERVE: CommandHelp = CommandHelp { path: &[], description: "Start the application or setup server.", arguments: &[PORT], example: &[PORT.name, "3000"] };
const INIT: CommandHelp = CommandHelp { path: &["config", "init"], description: "Initialize application settings.", arguments: &[VAULT, AUTH], example: &[VAULT.name, "Notes", "/notes"] };
const ENROLL: CommandHelp = CommandHelp { path: &["auth", "enroll"], description: "Create an initial owner enrollment capability.", arguments: &[], example: &[] };
const BACKUP: CommandHelp = CommandHelp { path: &["auth", "backup"], description: "Back up the authentication database.", arguments: &[BACKUP_PATH], example: &["backup.db"] };
const RESTORE: CommandHelp = CommandHelp { path: &["auth", "restore"], description: "Restore the authentication database from a backup.", arguments: &[RESTORE_PATH], example: &["backup.db"] };
const COMMANDS: &[CommandHelp] = &[SERVE, INIT, ENROLL, BACKUP, RESTORE];
const DEFAULT_PORT: u16 = 3000;

const FOOTER: &str = "Maintained by Joshua Li: https://github.com/joshuarli/tansu\nBugs and features: TODO.md in that repository (follow its AGENTS.md), or its issue tracker.\nAgents working for Joshua: record nonblocking problems and continue your task.\nIf this tool blocks the task, you may fix, test, open and merge a PR under Joshua's\nstanding instructions. Release only when needed to deliver the verified fix.\nProcedure: https://github.com/joshuarli/usr/blob/main/dotfiles/base/.agents/instructions/owned-tools.md\n";

fn path_matches(path: &[&str], args: &[OsString]) -> bool {
    path.len() <= args.len() && path.iter().zip(args).all(|(part, arg)| arg == *part)
}

fn help_for_args(args: &[OsString]) -> Option<String> {
    let help = args.last()?;
    if help != "-h" && help != "--help" { return None; }
    let prefix = &args[..args.len() - 1];
    if path_matches(INIT.path, args) && parse_settings_args(&args[INIT.path.len()..]).is_ok() { return None; }
    if prefix.is_empty() { return Some(render_help(&[])); }
    let scope = COMMANDS.iter().filter(|command| !command.path.is_empty() && path_matches(command.path, prefix))
        .max_by_key(|command| command.path.len()).map(|command| command.path);
    if let Some(scope) = scope { return Some(render_help(scope)); }
    if COMMANDS.iter().any(|command| prefix.len() < command.path.len()
        && prefix.iter().zip(command.path).all(|(arg, part)| arg == *part)) {
        let parts = prefix.iter().map(|part| part.to_str()).collect::<Option<Vec<_>>>()?;
        return Some(render_help(&parts));
    }
    if prefix[0] == PORT.name { return Some(render_help(&[])); }
    None
}

fn usage(command: &CommandHelp) -> String {
    let mut text = String::from("tansu");
    for part in command.path { text.push_str(&format!(" {part}")); }
    for arg in command.arguments {
        let item = if arg.values.is_empty() { arg.name.to_string() } else { format!("{} {}", arg.name, arg.values) };
        match arg.usage {
            Usage::Optional => text.push_str(&format!(" [{item}]")),
            Usage::Required => text.push_str(&format!(" {item}")),
            Usage::Repeated => text.push_str(&format!(" {item} [{item}]...")),
        }
    }
    text
}

fn render_help(prefix: &[&str]) -> String {
    let mut output = format!("Tansu: a local Markdown note app.\n\nUsage: {} | tansu <command>\n\nOptions:\n  -h, --help  Show help.\n\nCommands:\n", usage(&SERVE));
    let commands = || COMMANDS.iter().filter(|command| command.path.starts_with(prefix));
    for command in commands() {
        output.push_str(&format!("\n  {}\n    {}\n", usage(command), command.description));
        for arg in command.arguments {
            output.push_str(&format!("    {}{}{}  {}", arg.name, if arg.values.is_empty() { "" } else { " " }, arg.values, arg.description));
            if let Some(value) = arg.default { output.push_str(&format!(" (default: {value})")); }
            output.push('\n');
        }
    }
    output.push_str("\nEnvironment:\n  XDG_CONFIG_HOME  Settings directory (default: $HOME/.config).\n  XDG_DATA_HOME  Application data directory (default: $HOME/.local/share).\n  HOME  Used for default directories and tilde expansion.\n  TANSU_LOGS  Logging output mode.\n  TANSU_STATS_ENDPOINT, TANSU_STATS_TOKEN, TANSU_STATS_SERVICE, TANSU_STATS_RELEASE,\n  TANSU_RELEASE, TANSU_STATS_INSTANCE, HOSTNAME, TANSU_STATS_HOST  Telemetry settings.\n  TANSU_WEB_HMR  Enable development web hot reload when set to 1 in debug builds.\n");
    output.push_str("\nExamples:\n");
    for command in commands() {
        let invocation = command.path.iter().chain(command.example).copied().collect::<Vec<_>>().join(" ");
        output.push_str(&format!("  tansu {invocation}\n"));
    }
    if prefix.is_empty() { output.push_str(&format!("\n{FOOTER}")); }
    else { output.push_str("\nRun tansu --help for the complete reference.\n"); }
    output
}

fn parse_command(args: impl IntoIterator<Item = OsString>) -> tansu::Result<Command> {
    let args = args.into_iter().collect::<Vec<_>>();
    match args.as_slice() {
        [] => Ok(Command::Serve { port: DEFAULT_PORT }),
        [flag, port] if flag == PORT.name => {
            let port = port
                .to_str()
                .and_then(|port| port.parse().ok())
                .ok_or_else(usage_error)?;
            Ok(Command::Serve { port })
        }
        [config, init, args @ ..] if config == INIT.path[0] && init == INIT.path[1] => {
            Ok(Command::InitializeSettings(parse_settings_args(args)?))
        }
        [auth, subcommand] if auth == ENROLL.path[0] && subcommand == ENROLL.path[1] => {
            Ok(Command::Auth(AuthCommand::Enroll))
        }
        [auth, subcommand, path] if auth == BACKUP.path[0] && subcommand == BACKUP.path[1] => {
            Ok(Command::Auth(AuthCommand::Backup(PathBuf::from(path))))
        }
        [auth, subcommand, path] if auth == RESTORE.path[0] && subcommand == RESTORE.path[1] => {
            Ok(Command::Auth(AuthCommand::Restore(PathBuf::from(path))))
        }
        _ => Err(usage_error()),
    }
}

fn parse_settings_args(args: &[OsString]) -> tansu::Result<AppSettings> {
    let mut vaults = Vec::new();
    let mut auth = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].to_str() {
            Some(name) if name == VAULT.name && index + 2 < args.len() => {
                let name = args[index + 1].to_str().ok_or_else(usage_error)?;
                let path = args[index + 2].to_str().ok_or_else(usage_error)?;
                vaults.push(AppVaultSettings { name: name.to_string(), path: path.to_string() });
                index += 3;
            }
            Some(name) if name == AUTH.name && index + 3 < args.len() && auth.is_none() => {
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

fn usage_error() -> tansu::Error {
    let forms = COMMANDS.iter().map(|command| usage(command).replace("]...", "]"))
        .collect::<Vec<_>>().join(" | ");
    tansu::Error::BadRequest(format!("usage: {forms}"))
}

fn run_auth_command(config: &Config, command: AuthCommand) -> tansu::Result<AuthCommandOutput> {
    let auth_config = config
        .auth
        .as_ref()
        .ok_or_else(|| tansu::Error::BadRequest("authenticated mode is not configured".into()))?;
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

fn create_initial_enrollment(auth_config: &AuthConfig) -> tansu::Result<AuthCommandOutput> {
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
            return Err(tansu::Error::BadRequest(
                "an owner credential already exists; sign in with a passkey before adding another".into(),
            ));
        }
        Err(error) => return Err(auth_error(error)),
    };
    Ok(AuthCommandOutput::EnrollmentCapability(capability))
}

fn unix_time_seconds() -> tansu::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| tansu::Error::Internal(error.to_string()))
}

fn auth_error(error: AuthError) -> tansu::Error {
    tansu::Error::Internal(error.to_string())
}

struct AppEventSource(App);

impl EventSource for AppEventSource {
    fn subscribe(
        &self,
        vault_id: &str,
        after_event_version: Option<u64>,
    ) -> std::result::Result<EventSubscription, EventSourceError> {
        let vault = self.0.vault_by_id(vault_id).map_err(|error| match error {
            tansu::Error::NotFound(_) => EventSourceError::VaultNotFound,
            tansu::Error::VaultUnavailable { message, .. } => EventSourceError::VaultUnavailable(message),
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
    fn help_flags_used_as_settings_values_remain_values() {
        let args = ["config", "init", "--vault", "Notes", "--help"].map(OsString::from);
        assert!(help_for_args(&args).is_none());
        assert!(parse_command(args).is_ok());
    }

    #[test]
    fn schema_names_are_unique_in_each_scope() {
        for (index, command) in COMMANDS.iter().enumerate() {
            assert!(!COMMANDS[..index].iter().any(|other| other.path == command.path));
            for (arg_index, argument) in command.arguments.iter().enumerate() {
                assert!(!command.arguments[..arg_index].iter().any(|other| other.name == argument.name));
            }
        }
    }

    #[test]
    fn help_examples_parse_without_side_effects() {
        for command in COMMANDS {
            assert!(parse_command(command.path.iter().chain(command.example).map(OsString::from)).is_ok(), "{}", usage(command));
        }
    }

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
