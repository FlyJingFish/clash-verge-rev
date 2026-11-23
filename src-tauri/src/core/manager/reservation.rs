use anyhow::{Context as _, Result};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

/// Keeps MyClash from starting two of its own cores without treating another
/// app's `verge-mihomo` process as ours.
pub struct SidecarReservation {
    _file: File,
}

impl SidecarReservation {
    pub fn acquire() -> Result<Self> {
        Self::acquire_at(&reservation_path()?)
    }

    fn acquire_at(path: &Path) -> Result<Self> {
        let file = open_reservation(path)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                anyhow::bail!("process myclash-mihomo remains after IPC failure; refusing a second core")
            }
            Err(std::fs::TryLockError::Error(error)) => Err(error).context("could not reserve MyClash core execution"),
        }
    }

    pub fn release_after_exit(
        self,
        pid: u32,
        mut terminated: tokio::sync::oneshot::Receiver<()>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut events_open = true;
            while !process_has_exited(pid) {
                tokio::select! {
                    result = &mut terminated, if events_open => {
                        if result.is_ok() {
                            break;
                        }
                        events_open = false;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                }
            }
            drop(self);
        })
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub async fn confirm_sidecar_idle() -> Result<()> {
    SidecarReservation::acquire().map(|_| ())
}

fn reservation_path() -> Result<PathBuf> {
    #[cfg(unix)]
    {
        Ok(PathBuf::from("/tmp/myclash.core-execution.lock"))
    }
    #[cfg(windows)]
    {
        Ok(std::env::temp_dir().join("myclash.core-execution.lock"))
    }
}

fn open_reservation(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
        .open(path)
        .with_context(|| format!("could not open core reservation {}", path.display()))
}

#[cfg(unix)]
fn process_has_exited(pid: u32) -> bool {
    let pid = libc::pid_t::try_from(pid).unwrap_or(-1);
    (unsafe { libc::kill(pid, 0) }) == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_has_exited(pid: u32) -> bool {
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, SYNCHRONIZATION_SYNCHRONIZE, WaitForSingleObject},
    };
    let raw = unsafe { OpenProcess(SYNCHRONIZATION_SYNCHRONIZE, 0, pid) };
    if raw.is_null() {
        return std::io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32);
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    (unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) }) == WAIT_OBJECT_0
}

#[cfg(test)]
mod tests {
    use super::SidecarReservation;
    use std::fs;

    #[test]
    fn a_second_reservation_is_refused_while_the_first_is_held() {
        let path = std::env::temp_dir().join(format!("myclash-reservation-{}-{}.lock", std::process::id(), line!()));
        let _ = fs::remove_file(&path);
        let held = SidecarReservation::acquire_at(&path).expect("first reservation");
        let refused = SidecarReservation::acquire_at(&path);
        assert!(refused.is_err());
        drop(held);
        let _ = fs::remove_file(&path);
    }
}
