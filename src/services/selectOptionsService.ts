export function replaceSelectOptions(
    select: HTMLSelectElement | null | undefined,
    items: string[],
    placeholderText: string | null = null,
) {
    if (!select) return;

    const fragment = document.createDocumentFragment();
    if (placeholderText) {
        const option = document.createElement('option');
        option.value = '';
        option.disabled = true;
        option.selected = true;
        option.textContent = placeholderText;
        fragment.appendChild(option);
    }

    for (const item of items) {
        const option = document.createElement('option');
        option.value = item;
        option.textContent = item;
        fragment.appendChild(option);
    }

    select.replaceChildren(fragment);
}
