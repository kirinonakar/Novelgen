use std::collections::BTreeMap;
use windows::core::{w, Result};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, DWRITE_FACTORY_TYPE_SHARED,
};

fn family_name(collection: &IDWriteFontCollection, index: u32) -> Result<String> {
    // DirectWrite reports the UTF-16 length without the terminating NUL.
    unsafe {
        let names = collection.GetFontFamily(index)?.GetFamilyNames()?;
        let mut english_index = 0;
        let mut has_english = Default::default();
        names.FindLocaleName(w!("en-us"), &mut english_index, &mut has_english)?;
        let index = if has_english.as_bool() {
            english_index
        } else {
            0
        };
        let length = names.GetStringLength(index)? as usize;
        let mut buffer = vec![0; length + 1];
        names.GetString(index, &mut buffer)?;
        Ok(String::from_utf16_lossy(&buffer[..length]))
    }
}

pub fn installed_font_families() -> Result<Vec<String>> {
    let mut collection = None;
    // The factory writes a COM interface into the initialized output parameter.
    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        factory.GetSystemFontCollection(&mut collection, true)?;
    }
    let Some(collection) = collection else {
        return Ok(Vec::new());
    };

    let count = unsafe { collection.GetFontFamilyCount() };
    let families: BTreeMap<_, _> = (0..count)
        .filter_map(|index| family_name(&collection, index).ok())
        .filter(|name| !name.is_empty())
        .map(|name| (name.to_lowercase(), name))
        .collect();
    Ok(families.into_values().collect())
}
