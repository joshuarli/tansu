use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;

use crate::api_types::PathValidationReason;
use crate::{Error, Result};

pub fn normalize_note_path(input: &str) -> std::result::Result<String, PathValidationReason> {
    let trimmed = input.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(PathValidationReason::Empty);
    }
    let path = Path::new(&trimmed);
    if path.is_absolute() {
        return Err(PathValidationReason::Absolute);
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let text = value.to_string_lossy();
                if text == ".tansu" {
                    return Err(PathValidationReason::DotTansu);
                }
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
            Component::ParentDir => return Err(PathValidationReason::Traversal),
            Component::CurDir => {}
            _ => return Err(PathValidationReason::Absolute),
        }
    }
    if parts.is_empty() {
        return Err(PathValidationReason::Empty);
    }
    let normalized = parts.join("/");
    if !normalized.to_ascii_lowercase().ends_with(".md") {
        return Err(PathValidationReason::NotMarkdown);
    }
    Ok(normalized)
}

pub fn path_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

pub fn visible_path(root: &Path, note_path: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for part in note_path.split('/') {
        out.push(part);
    }
    out
}

pub fn checked_visible_path(root: &Path, note_path: &str) -> Result<PathBuf> {
    let normalized = normalize_note_path(note_path)
        .map_err(|_| Error::BadRequest("invalid visible path".to_string()))?;
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Error::BadRequest(
            "vault root must be a real directory".to_string(),
        ));
    }
    let root = root.canonicalize()?;
    let mut path = root.clone();
    let mut missing = false;
    let parts = normalized.split('/').collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        if missing {
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(Error::BadRequest(
                        "visible paths cannot contain symlinks".to_string(),
                    ));
                }
                if index + 1 < parts.len() && !metadata.is_dir() {
                    return Err(Error::BadRequest(
                        "visible path parent is not a directory".to_string(),
                    ));
                }
                if path.canonicalize()?.strip_prefix(&root).is_err() {
                    return Err(Error::BadRequest(
                        "visible path escapes the vault".to_string(),
                    ));
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => missing = true,
            Err(error) => return Err(Error::Io(error)),
        }
    }
    Ok(path)
}

pub fn read_visible_bytes(root: &Path, note_path: &str) -> Result<Vec<u8>> {
    let normalized = normalize_note_path(note_path)
        .map_err(|_| Error::BadRequest("invalid visible path".to_string()))?;
    let mut file = open_vault_file(root, Path::new(&normalized))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn write_visible_note_bytes_new(root: &Path, note_path: &str, bytes: &[u8]) -> Result<()> {
    write_visible_note_bytes(root, note_path, bytes, true)
}

pub fn write_visible_note_bytes_atomic(root: &Path, note_path: &str, bytes: &[u8]) -> Result<()> {
    write_visible_note_bytes(root, note_path, bytes, false)
}

fn write_visible_note_bytes(
    root: &Path,
    note_path: &str,
    bytes: &[u8],
    no_clobber: bool,
) -> Result<()> {
    let (directory, leaf) = open_visible_parent(root, note_path, true)?;
    if !no_clobber {
        verify_visible_leaf(&directory, &leaf)?;
    }
    #[cfg(test)]
    crate::failure_point::check(crate::failure_point::FailurePoint::VisibleFileStorageFull)?;
    for _ in 0..8 {
        let temp = CString::new(format!(".tansu-{:016x}.tmp", fastrand::u64(..)))
            .map_err(|_| Error::Internal("invalid temporary file name".to_string()))?;
        // SAFETY: directory is open and the unique temp name is nul-terminated.
        let fd = unsafe {
            openat(
                directory.as_raw_fd(),
                temp.as_ptr(),
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                0o600_u32,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::AlreadyExists {
                continue;
            }
            return Err(Error::Io(error));
        }
        // SAFETY: openat returned a new descriptor that is transferred to File exactly once.
        let mut file = unsafe { File::from_raw_fd(fd) };
        let write_result = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        if let Err(error) = write_result {
            unlink_at(directory.as_raw_fd(), &temp)?;
            return Err(Error::Io(error));
        }
        let result = if no_clobber {
            link_at(directory.as_raw_fd(), &temp, directory.as_raw_fd(), &leaf)
        } else {
            rename_at(directory.as_raw_fd(), &temp, directory.as_raw_fd(), &leaf)
        };
        if let Err(error) = result {
            unlink_at(directory.as_raw_fd(), &temp)?;
            return Err(error);
        }
        if no_clobber {
            unlink_at(directory.as_raw_fd(), &temp)?;
        }
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::VisibleFileReplaced)?;
        directory.sync_all()?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::DirectorySynced)?;
        return Ok(());
    }
    Err(Error::Internal(
        "could not allocate a visible file temp name".to_string(),
    ))
}

pub fn remove_visible_note_file(root: &Path, note_path: &str) -> Result<()> {
    let (directory, leaf) = open_visible_parent(root, note_path, false)?;
    let file = openat_path(
        directory.as_raw_fd(),
        std::ffi::OsStr::from_bytes(leaf.as_bytes()),
        O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC,
    )?;
    if !file.metadata()?.is_file() {
        return Err(Error::BadRequest(
            "visible path is not a regular file".to_string(),
        ));
    }
    drop(file);
    unlink_at(directory.as_raw_fd(), &leaf)?;
    directory.sync_all()?;
    Ok(())
}

pub fn sync_visible_note_parent(root: &Path, note_path: &str) -> Result<()> {
    let (directory, _) = open_visible_parent(root, note_path, false)?;
    directory.sync_all()?;
    Ok(())
}

fn open_visible_parent(root: &Path, note_path: &str, create: bool) -> Result<(File, CString)> {
    let normalized = normalize_note_path(note_path)
        .map_err(|_| Error::BadRequest("invalid visible path".to_string()))?;
    let parts = Path::new(&normalized)
        .components()
        .map(|component| match component {
            Component::Normal(part) => Ok(part),
            _ => Err(Error::BadRequest("invalid visible path".to_string())),
        })
        .collect::<Result<Vec<_>>>()?;
    let root_directory = openat_path(
        current_directory(),
        root.as_os_str(),
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
    )?;
    if !root_directory.metadata()?.is_dir() {
        return Err(Error::BadRequest("vault root must be a directory".to_string()));
    }
    let mut directory = root_directory;
    for part in &parts[..parts.len() - 1] {
        directory = match openat_path(
            directory.as_raw_fd(),
            part,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
        ) {
            Ok(directory) => directory,
            Err(Error::Io(error)) if create && error.kind() == ErrorKind::NotFound => {
                let name = CString::new(part.as_bytes())
                    .map_err(|_| Error::BadRequest("visible path contains a nul byte".to_string()))?;
                // SAFETY: directory is open and the component name is nul-terminated.
                let result = unsafe { mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                if result < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() != ErrorKind::AlreadyExists {
                        return Err(Error::Io(error));
                    }
                }
                directory.sync_all()?;
                openat_path(
                    directory.as_raw_fd(),
                    part,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
                )?
            }
            Err(error) => return Err(error),
        };
    }
    let leaf = CString::new(parts[parts.len() - 1].as_bytes())
        .map_err(|_| Error::BadRequest("visible path contains a nul byte".to_string()))?;
    Ok((directory, leaf))
}

fn verify_visible_leaf(directory: &File, leaf: &CString) -> Result<()> {
    match openat_path(
        directory.as_raw_fd(),
        std::ffi::OsStr::from_bytes(leaf.as_bytes()),
        O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC,
    ) {
        Ok(file) if file.metadata()?.is_file() => Ok(()),
        Ok(_) => Err(Error::BadRequest(
            "visible path is not a regular file".to_string(),
        )),
        Err(Error::Io(error)) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn link_at(source_directory: RawFd, source: &CString, destination_directory: RawFd, destination: &CString) -> Result<()> {
    // SAFETY: both descriptors are live and both names are nul-terminated.
    let result = unsafe {
        linkat(
            source_directory,
            source.as_ptr(),
            destination_directory,
            destination.as_ptr(),
            0,
        )
    };
    if result < 0 {
        return Err(Error::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

fn rename_at(directory: RawFd, source: &CString, destination_directory: RawFd, destination: &CString) -> Result<()> {
    // SAFETY: both descriptors are live and both names are nul-terminated.
    let result = unsafe {
        renameat(
            directory,
            source.as_ptr(),
            destination_directory,
            destination.as_ptr(),
        )
    };
    if result < 0 {
        return Err(Error::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

fn unlink_at(directory: RawFd, name: &CString) -> Result<()> {
    // SAFETY: directory is live and name is nul-terminated.
    let result = unsafe { unlinkat(directory, name.as_ptr(), 0) };
    if result < 0 {
        return Err(Error::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

pub fn read_vault_asset(root: &Path, name: &str) -> Result<Vec<u8>> {
    let relative = Path::new(name);
    if relative.is_absolute()
        || relative.components().next() != Some(Component::Normal("z-images".as_ref()))
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(Error::BadRequest("asset must be under z-images/".to_string()));
    }
    let mut file = open_vault_file(root, relative)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn write_vault_asset_new(root: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let relative = Path::new(name);
    if relative.is_absolute()
        || relative.components().next() != Some(Component::Normal("z-images".as_ref()))
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(Error::BadRequest("asset must be under z-images/".to_string()));
    }
    let mut directory = openat_path(
        current_directory(),
        root.as_os_str(),
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
    )?;
    let parts = relative.components().collect::<Vec<_>>();
    for component in &parts[..parts.len() - 1] {
        let Component::Normal(name) = component else {
            return Err(Error::BadRequest("invalid vault path".to_string()));
        };
        directory = match openat_path(
            directory.as_raw_fd(),
            name,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
        ) {
            Ok(directory) => directory,
            Err(Error::Io(error)) if error.kind() == ErrorKind::NotFound => {
                let name_c = CString::new(name.as_bytes())
                    .map_err(|_| Error::BadRequest("asset path contains a nul byte".to_string()))?;
                // SAFETY: the directory descriptor is live and the component is nul-terminated.
                let created = unsafe { mkdirat(directory.as_raw_fd(), name_c.as_ptr(), 0o700) };
                if created < 0 && std::io::Error::last_os_error().kind() != ErrorKind::AlreadyExists {
                    return Err(Error::Io(std::io::Error::last_os_error()));
                }
                directory.sync_all()?;
                openat_path(
                    directory.as_raw_fd(),
                    name,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
                )?
            }
            Err(error) => return Err(error),
        };
    }
    let Component::Normal(name) = parts[parts.len() - 1] else {
        return Err(Error::BadRequest("invalid vault path".to_string()));
    };
    let destination = CString::new(name.as_bytes())
        .map_err(|_| Error::BadRequest("asset path contains a nul byte".to_string()))?;
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let directory_fd = directory.as_raw_fd();
    let (temp_name, mut file) = loop {
        let temp = CString::new(format!(
            ".asset-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ))
        .expect("generated asset temp name has no nul byte");
        // SAFETY: directory is live, the temp name is nul-terminated, and the mode is supplied.
        let fd = unsafe {
            openat(
                directory_fd,
                temp.as_ptr(),
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                0o600_u32,
            )
        };
        if fd >= 0 {
            // SAFETY: openat returned a new descriptor that is transferred to File exactly once.
            break (temp, unsafe { File::from_raw_fd(fd) });
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != ErrorKind::AlreadyExists {
            return Err(Error::Io(error));
        }
    };
    let write_result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        let cleanup = unlink_at(directory_fd, &temp_name);
        return match cleanup {
            Ok(()) => Err(Error::Io(error)),
            Err(cleanup_error) => Err(Error::Internal(format!(
                "asset write failed: {error}; temporary asset cleanup failed: {cleanup_error}"
            ))),
        };
    }
    if let Err(error) = link_at(directory_fd, &temp_name, directory_fd, &destination) {
        let cleanup = unlink_at(directory_fd, &temp_name);
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(Error::Internal(format!(
                "asset publish failed: {error}; temporary asset cleanup failed: {cleanup_error}"
            ))),
        };
    }
    unlink_at(directory_fd, &temp_name)?;
    directory.sync_all()?;
    Ok(())
}

fn open_vault_file(root: &Path, relative: &Path) -> Result<File> {
    let root_fd = openat_path(
        current_directory(),
        root.as_os_str(),
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
    )?;
    let mut directory = root_fd;
    let parts = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => Ok(part),
            _ => Err(Error::BadRequest("invalid vault path".to_string())),
        })
        .collect::<Result<Vec<_>>>()?;
    if parts.is_empty() {
        return Err(Error::BadRequest("invalid vault path".to_string()));
    }
    for part in &parts[..parts.len() - 1] {
        let next = openat_path(
            directory.as_raw_fd(),
            part,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
        )?;
        directory = next;
    }
    let file = openat_path(
        directory.as_raw_fd(),
        parts[parts.len() - 1],
        O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC,
    )?;
    if !file.metadata()?.is_file() {
        return Err(Error::BadRequest("vault path is not a regular file".to_string()));
    }
    Ok(file)
}

const O_RDONLY: i32 = rustix::fs::OFlags::RDONLY.bits() as i32;
const O_WRONLY: i32 = rustix::fs::OFlags::WRONLY.bits() as i32;
const O_CREAT: i32 = rustix::fs::OFlags::CREATE.bits() as i32;
const O_EXCL: i32 = rustix::fs::OFlags::EXCL.bits() as i32;
const O_DIRECTORY: i32 = rustix::fs::OFlags::DIRECTORY.bits() as i32;
const O_NOFOLLOW: i32 = rustix::fs::OFlags::NOFOLLOW.bits() as i32;
const O_NONBLOCK: i32 = rustix::fs::OFlags::NONBLOCK.bits() as i32;
const O_CLOEXEC: i32 = rustix::fs::OFlags::CLOEXEC.bits() as i32;

fn current_directory() -> RawFd {
    rustix::fs::CWD.as_raw_fd()
}

fn openat_path(directory: RawFd, path: &std::ffi::OsStr, flags: i32) -> Result<File> {
    let path = CString::new(path.as_bytes())
        .map_err(|_| Error::BadRequest("vault path contains a nul byte".to_string()))?;
    // SAFETY: path is nul-terminated, and the returned descriptor is uniquely owned below.
    let fd = unsafe { openat(directory, path.as_ptr(), flags) };
    if fd < 0 {
        return Err(Error::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: openat returned a new descriptor that is transferred to File exactly once.
    Ok(unsafe { File::from_raw_fd(fd) })
}

unsafe extern "C" {
    fn openat(directory: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn mkdirat(directory: i32, path: *const std::ffi::c_char, mode: u32) -> i32;
    fn linkat(
        source_directory: i32,
        source: *const std::ffi::c_char,
        destination_directory: i32,
        destination: *const std::ffi::c_char,
        flags: i32,
    ) -> i32;
    fn renameat(
        source_directory: i32,
        source: *const std::ffi::c_char,
        destination_directory: i32,
        destination: *const std::ffi::c_char,
    ) -> i32;
    fn unlinkat(directory: i32, path: *const std::ffi::c_char, flags: i32) -> i32;
}

pub fn create_visible_parent(root: &Path, note_path: &str) -> Result<PathBuf> {
    let normalized = normalize_note_path(note_path)
        .map_err(|_| Error::BadRequest("invalid visible path".to_string()))?;
    let root_metadata = fs::symlink_metadata(root)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(Error::BadRequest(
            "vault root must be a real directory".to_string(),
        ));
    }
    let root = root.canonicalize()?;
    let mut parent = root.clone();
    let parts = normalized.split('/').collect::<Vec<_>>();
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        parent.push(part);
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(Error::BadRequest(
                    "visible path parent must be a real directory".to_string(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => fs::create_dir(&parent)?,
            Err(error) => return Err(Error::Io(error)),
        }
        if parent.canonicalize()?.strip_prefix(&root).is_err() {
            return Err(Error::BadRequest(
                "visible path escapes the vault".to_string(),
            ));
        }
    }
    checked_visible_path(&root, &normalized)
}

pub fn title_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Untitled")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        assert_eq!(
            normalize_note_path("../x.md").unwrap_err(),
            PathValidationReason::Traversal
        );
        assert_eq!(
            normalize_note_path(".tansu/x.md").unwrap_err(),
            PathValidationReason::DotTansu
        );
    }

    #[test]
    fn normalizes_separators_and_case_key() {
        assert_eq!(
            normalize_note_path("Notes\\One.md").unwrap(),
            "Notes/One.md"
        );
        assert_eq!(path_key("Notes/One.md"), "notes/one.md");
        assert_eq!(path_key("Ä.md"), path_key("ä.md"));
        assert_ne!(path_key("É.md"), path_key("E\u{301}.md"));
    }

    #[test]
    fn visible_paths_reject_symlinked_parents_and_leaves() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        fs::write(outside.path().join("note.md"), "outside").unwrap();
        symlink(outside.path().join("note.md"), root.path().join("note.md")).unwrap();

        assert!(checked_visible_path(root.path(), "linked/note.md").is_err());
        assert!(read_visible_bytes(root.path(), "note.md").is_err());
    }

    #[test]
    fn visible_parent_creation_stays_below_root() {
        let root = tempfile::tempdir().unwrap();
        let path = create_visible_parent(root.path(), "nested/note.md").unwrap();
        assert_eq!(
            path,
            root.path()
                .canonicalize()
                .unwrap()
                .join("nested/note.md")
        );
        assert!(root.path().join("nested").is_dir());
    }

    #[test]
    fn asset_reads_and_writes_reject_symlinked_directories_and_files() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("z-images")).unwrap();
        fs::write(root.path().join("z-images/safe.webp"), b"safe").unwrap();
        fs::write(outside.path().join("secret.webp"), b"secret").unwrap();
        symlink(
            outside.path().join("secret.webp"),
            root.path().join("z-images/linked.webp"),
        )
        .unwrap();

        assert_eq!(read_vault_asset(root.path(), "z-images/safe.webp").unwrap(), b"safe");
        assert!(read_vault_asset(root.path(), "z-images/linked.webp").is_err());
        assert!(write_vault_asset_new(root.path(), "z-images/created.webp", b"new").is_ok());
        assert_eq!(fs::read(root.path().join("z-images/created.webp")).unwrap(), b"new");

        fs::remove_dir_all(root.path().join("z-images")).unwrap();
        symlink(outside.path(), root.path().join("z-images")).unwrap();
        assert!(read_vault_asset(root.path(), "z-images/secret.webp").is_err());
        assert!(write_vault_asset_new(root.path(), "z-images/new.webp", b"new").is_err());
    }

    #[test]
    fn note_writes_and_removals_stay_inside_the_vault() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("note.md"), b"outside").unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        symlink(outside.path().join("note.md"), root.path().join("leaf.md")).unwrap();

        assert!(write_visible_note_bytes_atomic(root.path(), "linked/note.md", b"escaped").is_err());
        assert!(write_visible_note_bytes_atomic(root.path(), "leaf.md", b"replaced").is_err());
        assert!(remove_visible_note_file(root.path(), "linked/note.md").is_err());
        assert!(remove_visible_note_file(root.path(), "leaf.md").is_err());
        assert_eq!(fs::read(outside.path().join("note.md")).unwrap(), b"outside");

        write_visible_note_bytes_new(root.path(), "nested/new.md", b"inside").unwrap();
        assert!(write_visible_note_bytes_new(root.path(), "nested/new.md", b"clobber").is_err());
        write_visible_note_bytes_atomic(root.path(), "nested/new.md", b"replace").unwrap();
        assert_eq!(fs::read(root.path().join("nested/new.md")).unwrap(), b"replace");
    }

    #[test]
    fn operations_accept_a_root_relative_to_the_current_directory() {
        let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
        let current = std::env::current_dir().unwrap();
        let mut relative = PathBuf::new();
        for _ in current.components().skip(1) {
            relative.push("..");
        }
        relative.push(root.strip_prefix("/").unwrap());
        assert!(relative.is_relative());

        write_visible_note_bytes_new(&relative, "nested/note.md", b"note").unwrap();
        assert_eq!(read_visible_bytes(&relative, "nested/note.md").unwrap(), b"note");
        write_vault_asset_new(&relative, "z-images/image.webp", b"image").unwrap();
        assert_eq!(read_vault_asset(&relative, "z-images/image.webp").unwrap(), b"image");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn asset_reads_do_not_follow_a_replaced_parent_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("z-images")).unwrap();
        fs::write(root.path().join("z-images/value.webp"), b"safe").unwrap();
        fs::write(outside.path().join("value.webp"), b"secret").unwrap();
        let root_path = root.path().to_path_buf();
        let outside_path = outside.path().to_path_buf();
        let substitutions = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writer_substitutions = substitutions.clone();
        let writer = std::thread::spawn(move || {
            let visible = root_path.join("z-images");
            let hidden = root_path.join("z-images-hidden");
            for _ in 0..300 {
                if fs::rename(&visible, &hidden).is_ok() {
                    if symlink(&outside_path, &visible).is_ok() {
                        writer_substitutions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    let _ = fs::remove_file(&visible);
                    let _ = fs::rename(&hidden, &visible);
                }
            }
        });

        for _ in 0..300 {
            if let Ok(bytes) = read_vault_asset(root.path(), "z-images/value.webp") {
                assert_eq!(bytes, b"safe");
            }
        }
        writer.join().unwrap();
        assert!(substitutions.load(std::sync::atomic::Ordering::Relaxed) > 0);
    }
}
