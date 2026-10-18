mod api;
mod memory;
mod output_limits;
mod streams;
mod text;
mod types;
#[cfg(test)]
mod recovery_tests;

pub use api::{chat_completion, fetch_models_impl, generate_seed_impl};
pub use streams::{
    generate_novel_stream, generate_plot_stream, get_next_novel_filename, suggest_next_chapter,
};
pub use types::{NovelGenerationParams, NovelGenerationResult, StreamEvent};
