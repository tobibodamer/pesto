pub mod launch;
pub mod media;
pub mod press;
pub mod window;

/// Runs blocking Win32 work off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "something went wrong inside me".to_string())?
}
