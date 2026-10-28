//! Streaming entry points. Each submodule owns one part of generation.
mod events;
mod files;
mod novel;
mod plot;
mod protocol;

pub use files::{get_next_novel_filename, suggest_next_chapter};
pub use novel::generate_novel_stream;
pub use plot::generate_plot_stream;
