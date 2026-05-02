const CREDENTIAL_TARGET: &str = "NovelGen.GoogleApiKey";
const CREDENTIAL_USERNAME: &str = "Google API Key";

#[cfg(windows)]
mod platform {
    use super::{CREDENTIAL_TARGET, CREDENTIAL_USERNAME};
    use std::ffi::c_void;
    use std::ptr::{null_mut, NonNull};
    use std::slice;

    const CRED_TYPE_GENERIC: u32 = 1;
    const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
    const CRED_MAX_CREDENTIAL_BLOB_SIZE: usize = 5 * 512;
    const ERROR_NOT_FOUND: i32 = 1168;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct FILETIME {
        dwLowDateTime: u32,
        dwHighDateTime: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct CREDENTIAL_ATTRIBUTEW {
        Keyword: *mut u16,
        Flags: u32,
        ValueSize: u32,
        Value: *mut u8,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct CREDENTIALW {
        Flags: u32,
        Type: u32,
        TargetName: *mut u16,
        Comment: *mut u16,
        LastWritten: FILETIME,
        CredentialBlobSize: u32,
        CredentialBlob: *mut u8,
        Persist: u32,
        AttributeCount: u32,
        Attributes: *mut CREDENTIAL_ATTRIBUTEW,
        TargetAlias: *mut u16,
        UserName: *mut u16,
    }

    #[link(name = "Advapi32")]
    extern "system" {
        fn CredReadW(
            TargetName: *const u16,
            Type: u32,
            Flags: u32,
            Credential: *mut *mut CREDENTIALW,
        ) -> i32;
        fn CredWriteW(Credential: *const CREDENTIALW, Flags: u32) -> i32;
        fn CredDeleteW(TargetName: *const u16, Type: u32, Flags: u32) -> i32;
        fn CredFree(Buffer: *mut c_void);
    }

    fn wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_os_error() -> String {
        std::io::Error::last_os_error().to_string()
    }

    fn last_os_error_code() -> Option<i32> {
        std::io::Error::last_os_error().raw_os_error()
    }

    fn decode_credential_blob(blob: &[u8]) -> Result<String, String> {
        if blob.is_empty() {
            return Ok(String::new());
        }

        match String::from_utf8(blob.to_vec()) {
            Ok(value) => Ok(value),
            Err(_) if blob.len() % 2 == 0 => {
                let utf16 = blob
                    .chunks_exact(2)
                    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect::<Vec<_>>();
                String::from_utf16(&utf16).map_err(|e| e.to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn read_google_api_key() -> Result<Option<String>, String> {
        let target = wide_null(CREDENTIAL_TARGET);
        let mut credential_ptr: *mut CREDENTIALW = null_mut();

        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr) };

        if ok == 0 {
            if last_os_error_code() == Some(ERROR_NOT_FOUND) {
                return Ok(None);
            }
            return Err(last_os_error());
        }

        let credential = NonNull::new(credential_ptr).ok_or_else(|| {
            "Credential Manager returned an empty credential pointer.".to_string()
        })?;

        let result = unsafe {
            let credential = credential.as_ref();
            let blob = if credential.CredentialBlobSize == 0 || credential.CredentialBlob.is_null()
            {
                &[]
            } else {
                slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                )
            };
            decode_credential_blob(blob).map(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            })
        };

        unsafe {
            CredFree(credential_ptr.cast());
        }

        result
    }

    pub fn write_google_api_key(api_key: &str) -> Result<(), String> {
        let mut blob = api_key.as_bytes().to_vec();
        if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE {
            blob.fill(0);
            return Err("Google API key is too large for Windows Credential Manager.".to_string());
        }

        let target = wide_null(CREDENTIAL_TARGET);
        let username = wide_null(CREDENTIAL_USERNAME);
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_ptr() as *mut u16,
            Comment: null_mut(),
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: null_mut(),
            TargetAlias: null_mut(),
            UserName: username.as_ptr() as *mut u16,
        };

        let ok = unsafe { CredWriteW(&credential, 0) };
        blob.fill(0);

        if ok == 0 {
            Err(last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn delete_google_api_key() -> Result<(), String> {
        let target = wide_null(CREDENTIAL_TARGET);
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };

        if ok == 0 && last_os_error_code() != Some(ERROR_NOT_FOUND) {
            Err(last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn read_google_api_key() -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn write_google_api_key(_api_key: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn delete_google_api_key() -> Result<(), String> {
        Ok(())
    }
}

pub use platform::{delete_google_api_key, read_google_api_key, write_google_api_key};
