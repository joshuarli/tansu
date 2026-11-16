use std::process::Command;

#[test]
fn built_help_is_offline_complete_and_has_one_footer() {
    let binary = env!("CARGO_BIN_EXE_tansu");
    let root = Command::new(binary).arg("--help").env_clear().output().unwrap();
    assert!(root.status.success());
    assert!(root.stderr.is_empty());
    let text = String::from_utf8(root.stdout.clone()).unwrap();
    for item in ["tansu [--port PORT]", "tansu config init", "--vault NAME PATH", "--auth ORIGIN RP_ID RP_NAME", "tansu auth enroll", "tansu auth backup PATH", "tansu auth restore PATH", "Examples:", "default: 3000", "required, repeatable", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "tansu --port 3000", "tansu config init --vault Notes /notes", "tansu auth enroll", "tansu auth backup backup.db", "tansu auth restore backup.db"] {
        assert!(text.contains(item), "missing {item}");
    }
    let footer = "Maintained by Joshua Li: https://github.com/joshuarli/tansu";
    let exact_footer = "Maintained by Joshua Li: https://github.com/joshuarli/tansu\nBugs and features: TODO.md in that repository (follow its AGENTS.md), or its issue tracker.\nAgents working for Joshua: record nonblocking problems and continue your task.\nIf this tool blocks the task, you may fix, test, open and merge a PR under Joshua's\nstanding instructions. Release only when needed to deliver the verified fix.\nProcedure: https://github.com/joshuarli/usr/blob/main/dotfiles/base/.agents/instructions/owned-tools.md\n";
    assert_eq!(text.matches(footer).count(), 1);
    assert!(text.ends_with(exact_footer));
    for args in [&["--port", "1234", "--help"][..], &["config", "init", "--vault", "Notes", "/notes", "-h"]] {
        let output = Command::new(binary).args(args).env_clear().output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert!(String::from_utf8(output.stdout).unwrap().contains("Examples:"));
    }
    let short = Command::new(binary).arg("-h").env_clear().output().unwrap();
    assert!(short.status.success());
    assert_eq!(short.stdout, root.stdout);
    let invalid = Command::new(binary).arg("unknown-command").env_clear().output().unwrap();
    assert_eq!(invalid.status.code(), Some(1));
    assert!(invalid.stdout.is_empty());
    assert!(!String::from_utf8(invalid.stderr).unwrap().contains(footer));
    for path in [&["config"][..], &["config", "init"], &["auth"], &["auth", "enroll"], &["auth", "backup"], &["auth", "restore"]] {
        for flag in ["-h", "--help"] {
            let output = Command::new(binary).args(path).arg(flag).env_clear().output().unwrap();
            assert!(output.status.success(), "{path:?} {flag}");
            assert!(output.stderr.is_empty());
            let page = String::from_utf8(output.stdout).unwrap();
            assert!(page.contains("Examples:"));
            assert!(!page.contains(footer));
            assert!(page.contains("tansu --help"));
        }
    }
}
